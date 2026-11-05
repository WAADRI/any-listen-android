/**
 * 与 any-listen 服务端保持一条**常驻** WebSocket 的后端连接池。
 *
 * 设计要点：
 *
 * 1. 这条 WS 由中转进程持有，手机只发短连接 HTTP 请求。手机切换网络、
 *    NAT 超时、后台被系统冻结，都只会让「那一次 HTTP 请求」失败，
 *    不会让一条需要重新握手/inited 的长连接进入坏状态。
 * 2. WS 断开后，新的 HTTP 请求不会被立刻拒绝，而是**排队等重连**
 *    （默认最多等 10 秒），重连成功后自动补发。这正是把「重连」
 *    从客户端搬到服务端的意义。
 * 3. 上游服务端的空闲检测是 45s：它每 30s 发一次文本 `ping`，
 *    同时用协议级 ping 等 pong。这里**不回复文本 pong**（会被 close 4100），
 *    只把入站帧当作存活信号；超过 75s 没有任何入站帧就主动重连。
 */
import {
  buildSocketUrl,
  decodeFrame,
  encodeCallbackResponse,
  encodeRequest,
  encodeResponse,
  normalizeServerUrl,
  randomHex,
  sha256Hex,
  API_PREFIX,
  IPC_PATH,
  PING_TEXT,
} from './protocol.mjs'
import {
  AuthError,
  BackendUnavailableError,
  RpcError,
  RpcTimeoutError,
  StoppedError,
  errorText,
} from './errors.mjs'

const WS_OPEN = 1

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

export class AnyListenBackend {
  #opts
  #log
  #ws = null
  #state = 'idle'
  #token = null
  #serverId = ''
  #lastError = ''
  #pending = new Map()
  #queue = []
  #seq = 0
  #connectPromise = null
  #reconnectTimer = null
  #heartbeatTimer = null
  #reconnectAttempt = 0
  #connectFailures = 0
  #closedByUser = false
  #lastInboundAt = 0

  constructor(options) {
    if (!options || typeof options !== 'object') {
      throw new TypeError('AnyListenBackend 需要配置对象')
    }
    const serverUrl = normalizeServerUrl(options.serverUrl)
    if (!serverUrl) throw new TypeError('缺少 any-listen 服务器地址')
    if (!/^https?:\/\//i.test(serverUrl)) {
      throw new TypeError('any-listen 服务器地址必须以 http:// 或 https:// 开头')
    }

    this.#opts = {
      serverUrl,
      password: String(options.password ?? ''),
      fetchImpl: options.fetchImpl ?? globalThis.fetch,
      WebSocketImpl: options.WebSocketImpl ?? globalThis.WebSocket,
      callTimeoutMs: options.callTimeoutMs ?? 12_000,
      waitForReadyMs: options.waitForReadyMs ?? 10_000,
      connectTimeoutMs: options.connectTimeoutMs ?? 12_000,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 12_000,
      reconnectBaseMs: options.reconnectBaseMs ?? 500,
      reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
      authRetryMs: options.authRetryMs ?? 5 * 60_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 75_000,
      heartbeatCheckMs: options.heartbeatCheckMs ?? 15_000,
      random: options.random ?? Math.random,
      onStateChange: options.onStateChange ?? (() => {}),
    }
    if (typeof this.#opts.fetchImpl !== 'function') {
      throw new TypeError('当前运行环境没有 fetch（需要 Node 22+）')
    }
    if (typeof this.#opts.WebSocketImpl !== 'function') {
      throw new TypeError('当前运行环境没有 WebSocket（需要 Node 22+）')
    }
    this.#log = options.logger ?? silentLogger
  }

  get state() {
    return this.#state
  }

  get connected() {
    return this.#state === 'connected' && this.#isOpen()
  }

  /** 供 /healthz 使用：不包含任何密码/token。 */
  health() {
    return {
      state: this.#state,
      connected: this.connected,
      serverId: this.#serverId,
      lastError: this.#lastError,
      reconnectAttempt: this.#reconnectAttempt,
      pending: this.#pending.size,
      queued: this.#queue.length,
    }
  }

  start() {
    if (this.#closedByUser) return
    if (this.#connectPromise || this.#reconnectTimer || this.#isOpen()) return
    void this.#connectLoop()
  }

  stop() {
    if (this.#closedByUser) return
    this.#closedByUser = true
    this.#stopHeartbeat()
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    const ws = this.#ws
    this.#ws = null
    try {
      ws?.close()
    } catch {
      /* ignore */
    }

    const err = new StoppedError()
    for (const entry of this.#pending.values()) entry.settle(err)
    this.#pending.clear()
    for (const entry of this.#queue.splice(0)) entry.settle(err)

    this.#state = 'stopped'
    this.#emitState()
  }

  /**
   * 发起一次 RPC。未连接时会排队等待重连，而不是立刻失败。
   *
   * @param {string} method 服务端裸方法名（不接受点号路径）
   * @param {unknown[]} args
   * @param {{ timeoutMs?: number, waitForReadyMs?: number }} [options]
   */
  call(method, args = [], options = {}) {
    if (typeof method !== 'string' || !method) {
      return Promise.reject(new TypeError('RPC 方法名不能为空'))
    }
    if (this.#closedByUser) return Promise.reject(new StoppedError())
    if (!Array.isArray(args)) return Promise.reject(new TypeError('RPC args 必须是数组'))

    const timeoutMs = options.timeoutMs ?? this.#opts.callTimeoutMs
    const waitForReadyMs = options.waitForReadyMs ?? this.#opts.waitForReadyMs

    return new Promise((resolve, reject) => {
      const entry = {
        method,
        args,
        sent: false,
        settled: false,
        callId: null,
        timer: null,
        readyTimer: null,
        settle: null,
      }
      entry.settle = (err, value) => {
        if (entry.settled) return
        entry.settled = true
        if (entry.timer) clearTimeout(entry.timer)
        if (entry.readyTimer) clearTimeout(entry.readyTimer)
        entry.timer = null
        entry.readyTimer = null
        if (entry.callId) this.#pending.delete(entry.callId)
        this.#removeQueued(entry)
        if (err) reject(err)
        else resolve(value)
      }

      if (this.#isOpen()) {
        this.#dispatch(entry)
        return
      }

      this.#queue.push(entry)
      entry.readyTimer = setTimeout(() => {
        entry.settle(new BackendUnavailableError('中转后端在等待重连期间未就绪'))
      }, waitForReadyMs)
      this.#log.debug(`[queue] ${method} 等待后端重连（最多 ${waitForReadyMs}ms）`)
      this.#ensureConnecting()
    })
  }

  // ------------------------------------------------------------ 连接管理

  #ensureConnecting() {
    if (this.#closedByUser || this.#isOpen() || this.#connectPromise) return
    if (this.#reconnectTimer) return
    void this.#connectLoop()
  }

  async #connectLoop() {
    if (this.#closedByUser) return
    if (this.#connectPromise) return this.#connectPromise
    this.#connectPromise = this.#doConnect().finally(() => {
      this.#connectPromise = null
    })
    return this.#connectPromise
  }

  async #doConnect() {
    if (this.#closedByUser) return
    this.#setState('connecting')

    let ws = null
    try {
      if (!this.#token) await this.#handshake()
      if (this.#closedByUser) return

      const url = buildSocketUrl(this.#opts.serverUrl, this.#token)
      this.#log.debug(`[ws] 连接 ${safeSocketUrl(url)}`)
      ws = new this.#opts.WebSocketImpl(url)
      this.#ws = ws
      ws.addEventListener('message', (ev) => { this.#handleMessage(ws, ev) })
      ws.addEventListener('close', (ev) => { this.#handleClose(ws, ev) })
      // 连接错误后通常紧跟 close；waitOpen 里会以 error 提前失败。
      ws.addEventListener('error', () => {})

      await this.#waitOpen(ws)
      if (this.#closedByUser || this.#ws !== ws) return
      this.#handleOpen(ws)
    } catch (err) {
      if (this.#ws === ws) this.#ws = null
      try {
        ws?.close()
      } catch {
        /* ignore */
      }

      if (this.#closedByUser) return

      this.#lastError = errorText(err)
      if (err instanceof AuthError) {
        // 密码错误 / IP 封禁：重试只会让服务端继续累加失败次数。
        // 403 是「已被封禁」，等待封禁解除再重试；401 只能由使用者改配置后重启中转。
        this.#setState('auth-failed', this.#lastError)
        this.#log.error(`[auth] ${this.#lastError}`)
        if (err.status === 403) this.#scheduleReconnect(this.#opts.authRetryMs)
        return
      }

      this.#setState('disconnected', this.#lastError)
      this.#log.warn(`[ws] 连接失败：${this.#lastError}`)
      this.#connectFailures += 1
      // token 本身没有过期时间；但如果连续连不上（服务端换了 tokenSecret /
      // 会话被移除），下一次就重新握手，避免一直拿旧 token 撞墙。
      if (this.#connectFailures >= 3) this.#token = null
      this.#scheduleReconnect()
    }
  }

  async #waitOpen(ws) {
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (err) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (err) reject(err)
        else resolve()
      }
      const timer = setTimeout(() => {
        finish(new BackendUnavailableError('WebSocket 连接超时'))
      }, this.#opts.connectTimeoutMs)
      ws.addEventListener('open', () => finish())
      ws.addEventListener('close', () => finish(new BackendUnavailableError('WebSocket 连接被关闭')))
      ws.addEventListener('error', () => finish(new BackendUnavailableError('WebSocket 连接出错')))
    })
  }

  #handleOpen(ws) {
    if (this.#ws !== ws) return
    this.#state = 'connected'
    this.#reconnectAttempt = 0
    this.#connectFailures = 0
    this.#lastError = ''
    this.#lastInboundAt = Date.now()
    this.#startHeartbeat()
    this.#emitState()
    this.#log.info('[ws] 已连接 any-listen，开始中转')

    // 服务端广播按 socket 记 isInited，重连后归零，所以每次连上都要重发。
    // 失败不影响 RPC，只记一条日志。
    this.call('inited', [], { timeoutMs: 5_000, waitForReadyMs: 0 }).catch((err) => {
      this.#log.warn(`[ws] inited 失败：${errorText(err)}`)
    })

    const queued = this.#queue.splice(0)
    for (const entry of queued) this.#dispatch(entry)
  }

  #handleClose(ws, ev) {
    if (this.#ws !== ws) return
    this.#ws = null
    this.#stopHeartbeat()
    if (this.#closedByUser) return

    const code = ev && typeof ev.code === 'number' ? ev.code : 0
    this.#lastError = code ? `连接已断开（code ${code}）` : '连接已断开'
    this.#setState('disconnected', this.#lastError)
    this.#log.warn(`[ws] ${this.#lastError}`)

    const err = new BackendUnavailableError(this.#lastError)
    for (const entry of this.#pending.values()) entry.settle(err)
    this.#pending.clear()

    this.#scheduleReconnect()
  }

  #scheduleReconnect(explicitDelay) {
    if (this.#closedByUser || this.#reconnectTimer) return
    this.#reconnectAttempt += 1
    const base = explicitDelay ?? Math.min(
      this.#opts.reconnectBaseMs * 2 ** (this.#reconnectAttempt - 1),
      this.#opts.reconnectMaxMs,
    )
    const jitter = Math.floor(this.#opts.random() * Math.min(250, base / 4))
    const delay = Math.round(base + jitter)
    this.#log.info(`[ws] ${delay}ms 后重连（第 ${this.#reconnectAttempt} 次）`)
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      void this.#connectLoop()
    }, delay)
  }

  // ------------------------------------------------------------ 握手

  async #handshake() {
    const base = this.#opts.serverUrl
    const salt = randomHex(16)
    const m = sha256Hex(this.#opts.password + salt)
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), this.#opts.handshakeTimeoutMs)

    this.#log.info(`[auth] 握手 ${base}`)
    let res
    try {
      res = await this.#opts.fetchImpl(`${base}${API_PREFIX}${IPC_PATH}/ah`, {
        method: 'POST',
        headers: { m, s: salt },
        signal: ac.signal,
      })
    } catch (err) {
      throw new BackendUnavailableError(`握手请求失败：${errorText(err)}`)
    } finally {
      clearTimeout(timer)
    }

    if (res.status === 401) throw new AuthError('any-listen 密码错误', 401)
    if (res.status === 403) throw new AuthError('IP 已被 any-listen 封禁', 403)
    if (!res.ok) throw new BackendUnavailableError(`握手返回 HTTP ${res.status}`)

    let token = null
    try {
      token = res.headers.get('token')
    } catch {
      token = null
    }
    if (!token) throw new BackendUnavailableError('握手响应没有 token 头')

    // 确认对端确实是一个 any-listen：握手体是 Hello~::^-^::~v1~
    try {
      const body = await res.text()
      if (body && !body.startsWith('Hello~')) {
        throw new BackendUnavailableError('对端不是 any-listen 服务端')
      }
    } catch (err) {
      if (err instanceof BackendUnavailableError) throw err
      // 读体失败不致命：token 已经拿到了
    }

    this.#token = token
    this.#connectFailures = 0
    this.#log.info('[auth] 握手成功')
    await this.#fetchServerId(base)
  }

  async #fetchServerId(base) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 5_000)
    try {
      const res = await this.#opts.fetchImpl(`${base}${API_PREFIX}${IPC_PATH}/id`, { signal: ac.signal })
      if (!res.ok) return
      const body = await res.text()
      const idx = body.indexOf('-')
      this.#serverId = idx >= 0 ? body.slice(idx + 1).trim() : body.trim()
    } catch {
      /* 仅用于展示，不影响可用性 */
    } finally {
      clearTimeout(timer)
    }
  }

  // ------------------------------------------------------------ 帧处理

  #handleMessage(ws, ev) {
    if (this.#ws !== ws) return
    this.#lastInboundAt = Date.now()
    const raw = ev?.data
    if (typeof raw !== 'string') return
    if (raw === PING_TEXT) return

    const frame = decodeFrame(raw)
    switch (frame.kind) {
      case 'response': {
        const entry = this.#pending.get(frame.callId)
        if (!entry) return
        this.#pending.delete(frame.callId)
        if (frame.ok) entry.settle(null, frame.data)
        else entry.settle(new RpcError(frame.error?.message || '上游返回了未知错误'))
        return
      }
      case 'callback-request': {
        // 当前 App 没有注册任何入站回调；仍然要回一个应答，否则上游一直挂着。
        try {
          this.#ws?.send(encodeCallbackResponse(frame.callId, null))
        } catch {
          /* ignore */
        }
        return
      }
      case 'request': {
        // 服务端 → 客户端的调用/广播。中转不消费任何推送，回一个成功响应释放对端。
        // 必须用 op 1（RESPONSE），不能用 op 3（CALLBACK_RESPONSE）——见 protocol.mjs。
        try {
          this.#ws?.send(encodeResponse(frame.callId, null, null))
        } catch {
          /* ignore */
        }
        return
      }
      default:
        return
    }
  }

  #dispatch(entry) {
    if (entry.settled) return
    if (!this.#isOpen()) {
      if (!this.#queue.includes(entry)) this.#queue.push(entry)
      if (!entry.readyTimer) {
        entry.readyTimer = setTimeout(() => {
          entry.settle(new BackendUnavailableError('中转后端在等待重连期间未就绪'))
        }, this.#opts.waitForReadyMs)
      }
      this.#ensureConnecting()
      return
    }

    this.#removeQueued(entry)
    if (entry.readyTimer) {
      clearTimeout(entry.readyTimer)
      entry.readyTimer = null
    }

    const callId = `relay-${++this.#seq}`
    entry.callId = callId
    entry.sent = true
    this.#pending.set(callId, entry)
    entry.timer = setTimeout(() => {
      if (this.#pending.get(callId) === entry) this.#pending.delete(callId)
      entry.settle(new RpcTimeoutError(`调用 ${entry.method} 超时`))
    }, this.#opts.callTimeoutMs)

    try {
      this.#ws.send(encodeRequest(callId, entry.method, entry.args))
    } catch (err) {
      this.#pending.delete(callId)
      entry.settle(new BackendUnavailableError(`发送 ${entry.method} 失败：${errorText(err)}`))
    }
  }

  #removeQueued(entry) {
    const idx = this.#queue.indexOf(entry)
    if (idx >= 0) this.#queue.splice(idx, 1)
  }

  #isOpen() {
    return !!this.#ws && this.#ws.readyState === WS_OPEN
  }

  // ------------------------------------------------------------ 心跳 / 状态

  #startHeartbeat() {
    this.#stopHeartbeat()
    this.#heartbeatTimer = setInterval(() => {
      if (!this.#isOpen()) return
      const idle = Date.now() - this.#lastInboundAt
      if (idle <= this.#opts.heartbeatTimeoutMs) return
      this.#log.warn(`[ws] ${Math.round(idle / 1000)}s 没有收到任何帧，判定连接已死，主动重连`)
      const ws = this.#ws
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
      // 底层 socket 已经死了的话 close 可能迟迟不回；放弃它，直接进入重连。
      setTimeout(() => {
        if (this.#ws !== ws) return
        this.#ws = null
        this.#stopHeartbeat()
        this.#setState('disconnected', '心跳超时')
        const err = new BackendUnavailableError('心跳超时')
        for (const entry of this.#pending.values()) entry.settle(err)
        this.#pending.clear()
        this.#scheduleReconnect(0)
      }, 5_000)
    }, this.#opts.heartbeatCheckMs)
    // 不要因为心跳 interval 让进程无法退出
    this.#heartbeatTimer.unref?.()
  }

  #stopHeartbeat() {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer)
      this.#heartbeatTimer = null
    }
  }

  #setState(state, detail) {
    this.#state = state
    this.#emitState(detail)
  }

  #emitState(detail) {
    try {
      this.#opts.onStateChange(this.#state, detail)
    } catch {
      /* ignore */
    }
  }
}

/** 日志里带上 socket 地址时不要把 token 打出来。 */
function safeSocketUrl(url) {
  return String(url).replace(/([?&]m=)[^&]+/, '$1***')
}
