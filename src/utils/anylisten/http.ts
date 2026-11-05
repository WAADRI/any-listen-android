/**
 * any-listen 的 **HTTP 中转**传输层。
 *
 * ## 为什么需要它
 *
 * 直连 WS 时，连接是一个有状态的会话：断开后要重新握手 → 建 socket →
 * 重发 inited。Android 在后台会冻结 JS 定时器（真机日志里出现过断线后
 * 4 分钟才重连，而退避上限只有 30s），于是「重连」这件事本身就卡住了；
 * 等回到前台，界面上的操作才把它叫醒。
 *
 * 换成 HTTP 后：
 * - 每条 RPC 都是独立请求，不依赖上一条请求的连接状态；
 * - 失败只影响这一次调用，下一次调用会重新建连（OkHttp 处理切网/连接池）；
 * - 那条件宿 WS 由中转服务保持，手机不再需要维护它。
 *
 * 这不是「把 WS 换成轮询」：没有后台轮询，仍然只在有调用时发请求。
 *
 * ## 状态语义
 *
 * - `connected`：最近一次 /healthz 显示中转与 any-listen 都通；
 * - `connecting`：中转可达但后端还没好，或网络暂时失败，正在退避重试；
 * - `closed`：配置/令牌错误，或主动关闭。**只有**这两种情况是终态，
 *   避免 `waitForConnected()` 把一次临时断网误判成「再也不会好」。
 */
import type { AnyListenClient, ConnState } from './client'

/** 中转的 `/healthz` 返回。 */
export interface RelayHealth {
  connected: boolean
  state?: string
  serverId?: string
  lastError?: string
  relayVersion?: string
  pending?: number
  queued?: number
}

/** 中转 HTTP 层错误。`retryable` 决定调用方要不要重试。 */
export class RelayHttpError extends Error {
  status: number
  retryable: boolean

  constructor(status: number, message: string, retryable = false) {
    super(message)
    this.name = 'RelayHttpError'
    this.status = status
    this.retryable = retryable
  }
}

/** 上游返回的业务错误（与直连 WS 时的服务端错误等价），不重试。 */
export class RelayRpcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayRpcError'
  }
}

export interface RelayProbeResult {
  ok: boolean
  connected: boolean
  status: number
  message: string
  serverId?: string
  state?: string
  lastError?: string
}

const DEFAULT_HEALTH_TIMEOUT_MS = 5_000
// 中转在后端断开时会让请求排队等重连（默认 10s），再给上游 12s；
// 单次请求的预算必须覆盖这个最坏情况，否则 App 会在 relay 还在等的时候先超时。
const DEFAULT_CALL_TIMEOUT_MS = 30_000
const DEFAULT_RETRY_BASE_MS = 800
const MAX_CALL_ATTEMPTS = 3

export function normalizeRelayUrl(input: string | null | undefined): string {
  return String(input ?? '').trim().replace(/\/+$/, '')
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** RN 的 AbortController 在老版本里可能不存在；没有就退化成只靠超时竞速。 */
function createAbortController(): AbortController | null {
  try {
    if (typeof AbortController === 'function') return new AbortController()
  } catch {
    /* ignore */
  }
  return null
}

function relayHeaders(token: string, json = false): Record<string, string> {
  const headers: Record<string, string> = {}
  if (json) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

/** 读 /healthz。失败抛出 RelayHttpError；调用方据此区分「重试」与「改配置」。 */
export async function fetchRelayHealth(options: {
  relayUrl: string
  relayToken?: string
  fetchImpl: typeof fetch
  timeoutMs?: number
}): Promise<RelayHealth> {
  const base = normalizeRelayUrl(options.relayUrl)
  if (!base) throw new RelayHttpError(0, '尚未配置中转地址')

  const controller = createAbortController()
  const timer = setTimeout(() => {
    try {
      controller?.abort()
    } catch {
      /* ignore */
    }
  }, options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS)

  try {
    const res = await options.fetchImpl(`${base}/healthz`, {
      headers: relayHeaders(options.relayToken ?? ''),
      signal: controller?.signal,
    })
    const text = await res.text()

    if (res.status === 401 || res.status === 403) {
      throw new RelayHttpError(res.status, '中转令牌无效或未授权')
    }
    if (!res.ok) {
      throw new RelayHttpError(res.status, `中转服务返回 HTTP ${res.status}`, res.status >= 500)
    }

    let body: Record<string, unknown>
    try {
      body = JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new RelayHttpError(res.status, '中转服务返回了非 JSON 响应', true)
    }
    if (body.ok === false) {
      const error = body.error as { message?: unknown } | undefined
      throw new RelayHttpError(
        res.status,
        typeof error?.message === 'string' ? error.message : '中转服务返回错误',
      )
    }

    return {
      connected: body.connected === true,
      state: typeof body.state === 'string' ? body.state : undefined,
      serverId: typeof body.serverId === 'string' ? body.serverId : undefined,
      lastError: typeof body.lastError === 'string' ? body.lastError : undefined,
      relayVersion: typeof body.relayVersion === 'string' ? body.relayVersion : undefined,
      pending: typeof body.pending === 'number' ? body.pending : undefined,
      queued: typeof body.queued === 'number' ? body.queued : undefined,
    }
  } catch (err) {
    if (err instanceof RelayHttpError) throw err
    throw new RelayHttpError(0, `无法连接中转服务：${errText(err)}`, true)
  } finally {
    clearTimeout(timer)
  }
}

/** 设置页「测试连接」用：把异常压成一行可展示的结论。 */
export async function probeRelay(options: {
  relayUrl: string
  relayToken?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}): Promise<RelayProbeResult> {
  try {
    const health = await fetchRelayHealth({
      relayUrl: options.relayUrl,
      relayToken: options.relayToken,
      fetchImpl: options.fetchImpl ?? global.fetch as unknown as typeof fetch,
      timeoutMs: options.timeoutMs,
    })
    return {
      ok: true,
      connected: health.connected,
      status: 200,
      serverId: health.serverId,
      state: health.state,
      lastError: health.lastError,
      message: health.connected
        ? `中转与 any-listen 均已连接${health.serverId ? `（${health.serverId.slice(0, 8)}）` : ''}`
        : `中转可达，但 any-listen 后端未连接${health.lastError ? `：${health.lastError}` : ''}`,
    }
  } catch (err) {
    const status = err instanceof RelayHttpError ? err.status : 0
    return {
      ok: false,
      connected: false,
      status,
      message: errText(err),
    }
  }
}

export interface HttpSessionOptions {
  /** any-listen 的 HTTP 地址，仅用于解析封面/音频的相对地址。 */
  serverUrl: string
  relayUrl: string
  /** 中转访问令牌。中转未配置令牌时可省略。 */
  relayToken?: string
  fetchImpl: typeof fetch
  /** 单次调用的总预算（含重试与等待中转重连）。 */
  callTimeoutMs?: number
  healthTimeoutMs?: number
  retryBaseMs?: number
  onStateChange?: (state: ConnState, detail?: string) => void
  onError?: (message: string) => void
}

interface RequiredHttpOptions extends HttpSessionOptions {
  callTimeoutMs: number
  healthTimeoutMs: number
  retryBaseMs: number
  relayToken: string
}

/**
 * 与 `AnyListenSession` 同接口的 HTTP 实现。
 *
 * 没有心跳、没有 inited、没有 socket 状态机 —— 这些都搬到了中转服务里。
 */
export class AnyListenHttpSession implements AnyListenClient {
  private readonly opts: RequiredHttpOptions
  private state: ConnState = 'idle'
  private closedByUser = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  private connecting: Promise<void> | null = null
  private readonly inflight = new Set<AbortController>()
  private readonly handlers = new Map<string, (...args: unknown[]) => unknown>()

  constructor(options: HttpSessionOptions) {
    this.opts = {
      callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
      healthTimeoutMs: DEFAULT_HEALTH_TIMEOUT_MS,
      retryBaseMs: DEFAULT_RETRY_BASE_MS,
      relayToken: '',
      ...options,
    }
  }

  get serverUrl(): string {
    return this.opts.serverUrl
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

  /** 当前没有入站推送可消费；保留接口以兼容 AnyListenClient。 */
  on(name: string, handler: (...args: unknown[]) => unknown): void {
    this.handlers.set(name, handler)
  }

  /**
   * 探测一次中转。连不上时**不**进入 closed，而是留在 connecting 并退避重试，
   * 这样 `waitForConnected()` 会继续等，而不是把临时断网判成永久失败。
   */
  async connect(): Promise<void> {
    if (this.closedByUser || this.state === 'connected') return
    if (this.connecting) return this.connecting

    this.setState('connecting')
    this.connecting = this.checkOnce().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async checkOnce(): Promise<void> {
    try {
      const health = await fetchRelayHealth({
        relayUrl: this.opts.relayUrl,
        relayToken: this.opts.relayToken,
        fetchImpl: this.opts.fetchImpl,
        timeoutMs: this.opts.healthTimeoutMs,
      })
      if (this.closedByUser) return

      if (health.connected) {
        this.retryAttempt = 0
        this.setState('connected')
        return
      }

      const message = `中转已连上，但 any-listen 后端未连接${health.lastError ? `：${health.lastError}` : ''}`
      this.fail(message)
      this.setState('connecting', '中转后端未连接')
      this.scheduleRetry()
    } catch (err) {
      if (this.closedByUser) return
      if (err instanceof RelayHttpError && !err.retryable && (err.status === 401 || err.status === 403)) {
        this.setState('closed', err.message)
        this.fail(err.message)
        return
      }
      const message = errText(err)
      this.fail(message)
      this.setState('connecting', message)
      this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (this.closedByUser || this.retryTimer) return
    const ms = Math.min(this.opts.retryBaseMs * 2 ** this.retryAttempt, 30_000)
    this.retryAttempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.connect()
    }, ms)
  }

  /**
   * 发一次 RPC。
   *
   * 只在「中转 HTTP 不可达 / 5xx / 429」时重试；业务错误（`ok:false`）
   * 与直连 WS 时一样立即抛给调用方，避免重复执行写操作。
   *
   * 写操作（`listAction`）**不自动重试**：请求可能已经被中转转发到上游，
   * 只是响应丢了；再发一次会让「加歌」之类的动作执行两遍。这与直连 WS
   * 断线时 pending 调用直接失败的行为保持一致。
   */
  async call<T = unknown>(name: string, ...args: unknown[]): Promise<T> {
    if (this.closedByUser) throw new Error('会话已关闭')

    const canRetry = name !== 'listAction'
    const deadline = Date.now() + this.opts.callTimeoutMs
    let lastError: unknown = null

    for (let attempt = 0; attempt < (canRetry ? MAX_CALL_ATTEMPTS : 1); attempt++) {
      if (attempt > 0) {
        const wait = Math.min(this.opts.retryBaseMs * 2 ** (attempt - 1), 2_000)
        if (Date.now() + wait >= deadline) break
        await delay(wait)
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break

      try {
        const data = await this.postRpc<T>(name, args, Math.min(remaining, 25_000))
        if (this.state !== 'connected') this.setState('connected')
        return data
      } catch (err) {
        lastError = err
        if (err instanceof RelayRpcError) throw err
        if (err instanceof RelayHttpError && !err.retryable) throw err
      }
    }

    if (lastError instanceof Error) throw lastError
    throw new Error(`调用 ${name} 超时`)
  }

  private async postRpc<T>(name: string, args: unknown[], timeoutMs: number): Promise<T> {
    const base = normalizeRelayUrl(this.opts.relayUrl)
    if (!base) throw new RelayHttpError(0, '尚未配置中转地址')

    const controller = createAbortController()
    if (controller) this.inflight.add(controller)
    const timer = setTimeout(() => {
      try {
        controller?.abort()
      } catch {
        /* ignore */
      }
    }, Math.max(1, timeoutMs))

    try {
      const res = await this.opts.fetchImpl(`${base}/rpc`, {
        method: 'POST',
        headers: relayHeaders(this.opts.relayToken, true),
        body: JSON.stringify({ method: name, args }),
        signal: controller?.signal,
      })
      const text = await res.text()

      if (res.status === 401 || res.status === 403) {
        const err = new RelayHttpError(res.status, '中转令牌无效或未授权')
        this.setState('closed', err.message)
        throw err
      }
      if (res.status === 429) {
        throw new RelayHttpError(res.status, '中转限流，请稍后重试', true)
      }
      if (res.status >= 500) {
        throw new RelayHttpError(res.status, `中转服务暂时不可用（HTTP ${res.status}）`, true)
      }
      if (!res.ok) {
        throw new RelayHttpError(res.status, `中转服务返回 HTTP ${res.status}`)
      }

      let body: { ok?: unknown, data?: unknown, error?: { message?: unknown } }
      try {
        body = JSON.parse(text) as typeof body
      } catch {
        throw new RelayHttpError(res.status, '中转响应不是合法 JSON', true)
      }

      if (body.ok === true) return body.data as T
      const message = typeof body.error?.message === 'string' ? body.error.message : '中转返回了未知错误'
      throw new RelayRpcError(message)
    } catch (err) {
      if (err instanceof RelayHttpError || err instanceof RelayRpcError) throw err
      throw new RelayHttpError(0, `请求中转失败：${errText(err)}`, true)
    } finally {
      clearTimeout(timer)
      if (controller) this.inflight.delete(controller)
    }
  }

  /** 回到前台时补一次探测；HTTP 没有 socket 可重连，探测成功即恢复。 */
  reconnectNow(): void {
    if (this.closedByUser || this.state === 'connected') return
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.retryAttempt = 0
    void this.connect()
  }

  close(): void {
    this.closedByUser = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    for (const controller of this.inflight) {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }
    this.inflight.clear()
    this.handlers.clear()
    this.setState('closed')
  }
}
