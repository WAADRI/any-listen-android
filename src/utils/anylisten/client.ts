/**
 * any-listen 的鉴权握手与会话客户端。
 *
 * 本模块刻意**不直接 import react-native**：`fetch` 与 WebSocket 构造器由外部注入。
 * 这样它可以在 Node 里用假的网络层完整跑单测（见 client.test.ts），
 * 而真实的 RN 侧只是把 `global.fetch` 与 `global.WebSocket` 传进来。
 *
 * 已有的教训是：协议层「编译通过、测试通过、装到设备上却完全不工作」的 bug
 * 全部来自无法在本机验证的假设。把网络层做成可注入的，是让这些假设变成可测断言的办法。
 */
import { sha256Hex, randomHex } from './sha256'
import {
  OP,
  encodeRequest,
  encodeCallbackResponse,
  decodeFrame,
  isPing,
  PONG_TEXT,
} from './wire'

/** 握手 HTTP 路径前缀。 */
export const API_PREFIX = '/api'
export const IPC_PATH = '/ipc'
export const SOCKET_PATH = '/ipc/socket'

/**
 * 服务端 `/api/ipc/id` 返回的 id 前缀，是 `::id::` 的 base64。
 * 仅用于确认我们确实在对一个 any-listen 服务端说话。
 */
export const ID_PREFIX = 'OjppZDo6'

/** 握手响应体，用于确认协议版本。 */
export const HANDSHAKE_BODY = 'Hello~::^-^::~v1~\n'

export interface HandshakeResult {
  ok: true
  token: string
  serverId: string
}
export interface HandshakeFailure {
  ok: false
  /** HTTP 状态码；网络层失败时为 0 */
  status: number
  message: string
}

/** 把用户填的服务器地址规整成不带末尾斜杠的形式。 */
export function normalizeServerUrl(input: string): string {
  return input.trim().replace(/\/+$/, '')
}

export interface HandshakeParams {
  serverUrl: string
  password: string
  /** 注入的 fetch，便于测试与 RN 复用 */
  fetchImpl: typeof fetch
}

/**
 * 执行握手：`POST /api/ipc/ah`，头部 `m = sha256hex(password + salt)`、`s = salt`。
 *
 * 返回的 `token` 在响应头里，不在响应体里 —— 响应体是 `Hello~::^-^::~v1~`。
 * 这是很容易写错的一处：从 body 里找 token 会永远找不到。
 * token 是 JWT 形状（实测 207 字符），随后作为查询参数 `m` 用在 WebSocket 上。
 */
export async function handshake(params: HandshakeParams): Promise<HandshakeResult | HandshakeFailure> {
  const base = normalizeServerUrl(params.serverUrl)
  if (!base) return { ok: false, status: 0, message: '服务器地址为空' }
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, status: 0, message: '服务器地址必须以 http:// 或 https:// 开头' }
  }

  // salt 由客户端自选，服务端用同样的 salt 重算并比对
  const salt = randomHex(16)
  const m = sha256Hex(params.password + salt)

  let resp: Response
  try {
    resp = await params.fetchImpl(`${base}${API_PREFIX}${IPC_PATH}/ah`, {
      method: 'POST',
      headers: { m, s: salt },
    })
  } catch (err) {
    return { ok: false, status: 0, message: `无法连接服务器：${errText(err)}` }
  }

  if (resp.status === 401) return { ok: false, status: 401, message: '密码错误' }
  if (resp.status === 403) {
    return { ok: false, status: 403, message: 'IP 已被服务端封禁（连续失败次数过多，需等待或重启服务端）' }
  }
  if (resp.status !== 200) {
    return { ok: false, status: resp.status, message: `服务器返回 ${resp.status}` }
  }

  const token = resp.headers.get('token')
  if (!token) {
    return { ok: false, status: 200, message: '服务器没有返回 token 头' }
  }

  return { ok: true, token, serverId: await fetchServerId(base, params.fetchImpl) }
}

/** 读 `/api/ipc/id`，仅用于辨别对端身份；失败不影响可用性。 */
async function fetchServerId(base: string, fetchImpl: typeof fetch): Promise<string> {
  try {
    const resp = await fetchImpl(`${base}${API_PREFIX}${IPC_PATH}/id`)
    const body = await resp.text()
    const idx = body.indexOf('-')
    return idx >= 0 ? body.slice(idx + 1).trim() : body.trim()
  } catch {
    return ''
  }
}

/** 从服务器地址推导 WebSocket 地址。 */
export function buildSocketUrl(serverUrl: string, token: string): string {
  const base = normalizeServerUrl(serverUrl)
  const ws = base.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://')
  return `${ws}${API_PREFIX}${SOCKET_PATH}?m=${encodeURIComponent(token)}&t=main`
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** 连接状态。 */
export type ConnState = 'idle' | 'connecting' | 'connected' | 'closed'

export interface SessionOptions {
  serverUrl: string
  password: string
  /** WebSocket 构造器（RN 传 global.WebSocket） */
  WebSocketImpl: typeof WebSocket
  /** HTTP fetch（RN 传 global.fetch） */
  fetchImpl: typeof fetch
  /** 单次调用超时（毫秒） */
  callTimeoutMs?: number
  /** 心跳：多久没收到任何入站帧就判定连接已死（毫秒） */
  heartbeatTimeoutMs?: number
  /** 重连基础退避（毫秒） */
  reconnectBaseMs?: number
  /** 是否在连接建立后自动调用 inited */
  onStateChange?: (state: ConnState, detail?: string) => void
  onError?: (message: string) => void
}

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  name: string
}

/**
 * 一个 any-listen 会话：负责握手、建连、心跳、重连，以及 RPC 调用。
 *
 * 关于 `inited`：服务端所有广播都带
 * `if (socket.winType != 'main' || !socket.isInited) return`，
 * 而 `isInited` 是 **per-socket** 状态，重连后归零。
 * 漏发的表现是「连上了但永远收不到任何推送」，且不报错。
 * 所以本类在**每一次**连接变为 connected 时都重发 `inited`，见 `onOpen`。
 */
export class AnyListenSession {
  private ws: WebSocket | null = null
  private state: ConnState = 'idle'
  private seq = 0
  private pending = new Map<string, Pending>()
  private closedByUser = false
  private reconnectAttempt = 0
  private lastInboundAt = 0
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private token: string | null = null
  /** 入站请求处理器（服务端 → 客户端的调用） */
  private handlers = new Map<string, (...args: unknown[]) => unknown>()
  private opts: Required<Pick<SessionOptions, 'callTimeoutMs' | 'heartbeatTimeoutMs' | 'reconnectBaseMs'>> &
    SessionOptions

  constructor(options: SessionOptions) {
    this.opts = {
      callTimeoutMs: 15_000,
      heartbeatTimeoutMs: 46_000,
      reconnectBaseMs: 1_000,
      ...options,
    }
  }

  getState(): ConnState {
    return this.state
  }

  private setState(state: ConnState, detail?: string): void {
    this.state = state
    this.opts.onStateChange?.(state, detail)
  }

  private fail(message: string): void {
    this.opts.onError?.(message)
  }

  /** 注册一个服务端 → 客户端的入站方法。 */
  on(name: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(name, handler)
  }

  /** 建立连接。失败会按退避自动重试，直到 `close()`。 */
  async connect(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'connected') return
    this.closedByUser = false
    this.setState('connecting')

    const hs = await handshake({
      serverUrl: this.opts.serverUrl,
      password: this.opts.password,
      fetchImpl: this.opts.fetchImpl,
    })

    if (!hs.ok) {
      // 鉴权类错误不值得重试（密码错、被封禁），直接停在这里并上报
      this.setState('closed', hs.message)
      this.fail(hs.message)
      if (hs.status !== 401 && hs.status !== 403 && hs.status !== 0) return
      if (hs.status === 0) this.scheduleReconnect()
      return
    }

    this.token = hs.token
    this.openSocket()
  }

  private openSocket(): void {
    if (!this.token) return
    let url: string
    try {
      url = buildSocketUrl(this.opts.serverUrl, this.token)
    } catch (err) {
      this.fail(`WebSocket 地址无效：${errText(err)}`)
      return
    }

    let socket: WebSocket
    try {
      socket = new this.opts.WebSocketImpl(url)
    } catch (err) {
      this.fail(`创建 WebSocket 失败：${errText(err)}`)
      this.scheduleReconnect()
      return
    }
    this.ws = socket

    // 用 on* 而非 addEventListener：RN 的 WebSocket 两者都支持，
    // 但 on* 赋值在老版本上行为更确定，且这里不需要多监听者。
    socket.onopen = () => {
      this.reconnectAttempt = 0
      this.lastInboundAt = Date.now()
      this.setState('connected')
      this.startHeartbeat()
      // 每次连接成功都重发 inited —— 见类注释
      void this.call('inited').catch(() => {
        /* inited 失败不致命：下一次调用会正常报错 */
      })
    }

    socket.onmessage = (ev: WebSocketMessageEvent) => {
      this.lastInboundAt = Date.now()
      const raw = ev.data
      if (isPing(raw)) {
        try {
          socket.send(PONG_TEXT)
        } catch {
          /* 连接可能刚好关闭，忽略 */
        }
        return
      }
      this.handleFrame(raw)
    }

    socket.onerror = () => {
      // RN 的 onerror 事件不带可读信息，真正的判定交给 onclose 与心跳
    }

    socket.onclose = () => {
      this.stopHeartbeat()
      this.ws = null
      this.rejectAllPending(new Error('连接已断开'))
      if (this.closedByUser) {
        this.setState('closed')
        return
      }
      this.setState('closed', '连接断开，准备重连')
      this.scheduleReconnect()
    }
  }

  private handleFrame(raw: unknown): void {
    const frame = decodeFrame(raw)
    switch (frame.kind) {
      case 'response': {
        const p = this.pending.get(frame.callId)
        if (!p) return
        this.pending.delete(frame.callId)
        clearTimeout(p.timer)
        if (frame.ok) p.resolve(frame.data)
        else p.reject(new Error(frame.error.message))
        return
      }
      case 'callback-request': {
        // 服务端要求客户端回调。当前不需要，但必须回一个响应，
        // 否则服务端会一直挂着一个待决的回调。
        try {
          this.ws?.send(encodeCallbackResponse(frame.callId, null))
        } catch {
          /* ignore */
        }
        return
      }
      case 'request': {
        // 服务端 → 客户端的调用（例如广播 listAction）
        const name = frame.path[frame.path.length - 1]
        const handler = name ? this.handlers.get(name) : undefined
        const callId = frame.callId
        try {
          const result = handler?.(...(frame.args ?? []))
          if (result && typeof (result as Promise<unknown>).then === 'function') {
            void (result as Promise<unknown>).then(
              (value) => this.sendResponse(callId, null, value),
              (err) => this.sendResponse(callId, { message: errText(err) }),
            )
          } else {
            this.sendResponse(callId, null, result)
          }
        } catch (err) {
          this.sendResponse(callId, { message: errText(err) })
        }
        return
      }
      default:
        return
    }
  }

  private sendResponse(callId: string, error: { message: string } | null, data?: unknown): void {
    try {
      this.ws?.send(JSON.stringify([OP.RESPONSE, callId, error, data]))
    } catch {
      /* ignore */
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    // 服务端 45s 无活动就 terminate，所以只要安静超过阈值就主动重连
    this.heartbeatTimer = setInterval(() => {
      if (Date.now() - this.lastInboundAt > this.opts.heartbeatTimeoutMs) {
        // 判定连接已死：主动关闭，触发 onclose 里的重连
        try {
          this.ws?.close()
        } catch {
          /* ignore */
        }
      }
    }, 5_000)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return
    this.reconnectAttempt += 1
    // 指数退避，上限 30s
    const delay = Math.min(this.opts.reconnectBaseMs * 2 ** (this.reconnectAttempt - 1), 30_000)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  /**
   * 发起一次 RPC。
   *
   * `name` 传入**裸方法名**（如 `'getAllUserLists'`），不接受 `'list.getAllUserLists'`：
   * 服务端是平铺工厂，写成点号路径会让服务端在 `undefined` 上取属性，
   * 报错文本是字面的 `list is not defined`，且**每一个**调用都失败。
   *
   * ## 参数必须放在 `args`，绝不能并进方法名
   *
   * 这个签名（方法名单独一个参数、其余是真实参数）**必须**保持，
   * 因为它直接决定帧里 path 与 args 的分离：
   *
   * ```
   * call('getListMusics', listId)
   *   -> [0, callId, ['getListMusics'], [listId], []]
   * ```
   *
   * 一旦调用方写成 `call(['getListMusics', listId])` 之类把参数并入 path 的形态，
   * 服务端会遍历 path 到第二段并在 exposeObj 上取属性得到 undefined，
   * 返回 **`<listId> is not defined`**。
   *
   * ⚠️ 那个报错极具误导性：它看起来像「服务端不认识这个 listId」或
   * 「该歌单不存在」，很容易据此得出「服务端没有这个能力」的错误结论。
   * 本项目的开发过程中就曾被它误导过一轮 —— 真相只是调用方把 path
   * 与 args 写混了，服务端侧完全正常。
   *
   * 回归测试见 `wire.test.ts` 的「path 只有一段时应保持单段」用例。
   */
  call<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const socket = this.ws
      if (!socket || this.state !== 'connected') {
        reject(new Error(`连接未就绪（当前状态 ${this.state}）`))
        return
      }
      const callId = String(++this.seq)
      const timer = setTimeout(() => {
        this.pending.delete(callId)
        reject(new Error(`调用 ${name} 超时`))
      }, this.opts.callTimeoutMs)

      this.pending.set(callId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        name,
      })

      try {
        socket.send(encodeRequest(callId, [name], args))
      } catch (err) {
        this.pending.delete(callId)
        clearTimeout(timer)
        reject(new Error(`发送 ${name} 失败：${errText(err)}`))
      }
    })
  }

  /** 主动关闭，不再重连。 */
  close(): void {
    this.closedByUser = true
    this.stopHeartbeat()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.rejectAllPending(new Error('会话已关闭'))
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
    this.setState('closed')
  }
}
