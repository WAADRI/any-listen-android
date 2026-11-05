/**
 * 中转对手机暴露的 HTTP 接口。
 *
 * 只有两个路由：
 *
 *   GET  /healthz   → 中转与上游的连接状态（App 启动门禁、设置页「测试连接」用）
 *   POST /rpc       → { method, args }，转发到上游 WS，返回 { ok, data | error }
 *
 * 设计成**通用 RPC**而不是给每个 any-listen 方法开一个 REST 路由：
 * App 侧的调用点有十几个（歌单、取址、封面、歌词、写操作），
 * 通用 RPC 让 App 只需要换传输层，不必重写业务层。
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

import {
  BackendUnavailableError,
  RpcError,
  RpcTimeoutError,
  StoppedError,
  errorText,
} from './errors.mjs'

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}

/**
 * @param {{
 *   backend: { health: () => object, call: (method: string, args: unknown[], options?: object) => Promise<unknown> },
 *   token?: string,
 *   logger?: object,
 *   version?: string,
 *   bodyLimitBytes?: number,
 *   rpcTimeoutMs?: number,
 *   waitForReadyMs?: number,
 * }} options
 */
export function createRelayServer(options) {
  if (!options?.backend) throw new TypeError('createRelayServer 需要 backend')

  const backend = options.backend
  const token = String(options.token ?? '')
  const log = options.logger ?? silentLogger
  const version = options.version ?? '0.0.0'
  const bodyLimitBytes = options.bodyLimitBytes ?? 2 * 1024 * 1024
  const rpcTimeoutMs = options.rpcTimeoutMs ?? 22_000
  const waitForReadyMs = options.waitForReadyMs ?? 10_000

  const server = createServer((req, res) => {
    const startedAt = Date.now()
    handle(req, res)
      .catch((err) => {
        log.error(`[http] 未处理的异常：${errorText(err)}`)
        sendJson(res, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: '中转内部错误' } })
      })
      .finally(() => {
        log.debug(`[http] ${req.method} ${req.url} ${res.statusCode} ${Date.now() - startedAt}ms`)
      })
  })

  server.requestTimeout = 60_000
  server.headersTimeout = 10_000

  async function handle(req, res) {
    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: '中转令牌无效' } })
      return
    }

    const url = new URL(req.url ?? '/', 'http://relay.local')

    if (url.pathname === '/healthz') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 GET' } }, { Allow: 'GET' })
        return
      }
      sendJson(res, 200, { ok: true, relayVersion: version, ...backend.health() })
      return
    }

    if (url.pathname === '/rpc') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只支持 POST' } }, { Allow: 'POST' })
        return
      }

      let body
      try {
        body = await readJsonBody(req, bodyLimitBytes)
      } catch (err) {
        if (err instanceof HttpError) {
          sendJson(res, err.status, { ok: false, error: { code: 'BAD_REQUEST', message: err.message } })
          return
        }
        throw err
      }

      const method = body?.method
      const args = body?.args ?? []
      if (typeof method !== 'string' || !method) {
        sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'method 必须是非空字符串' } })
        return
      }
      if (!Array.isArray(args)) {
        sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'args 必须是数组' } })
        return
      }

      try {
        const data = await backend.call(method, args, { timeoutMs: rpcTimeoutMs, waitForReadyMs })
        sendJson(res, 200, { ok: true, data })
      } catch (err) {
        if (err instanceof RpcError) {
          // 业务错误：HTTP 200，让客户端按「调用失败」处理，不重试。
          sendJson(res, 200, { ok: false, error: { code: err.code, message: err.message } })
          return
        }
        if (err instanceof RpcTimeoutError) {
          sendJson(res, 504, { ok: false, error: { code: err.code, message: err.message, retryable: true } })
          return
        }
        if (err instanceof BackendUnavailableError || err instanceof StoppedError) {
          sendJson(
            res,
            503,
            { ok: false, error: { code: err.code, message: err.message, retryable: true } },
            { 'Retry-After': '2' },
          )
          return
        }
        log.error(`[rpc] ${method} 失败：${errorText(err)}`)
        sendJson(res, 500, { ok: false, error: { code: 'INTERNAL_ERROR', message: '中转内部错误' } })
      }
      return
    }

    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '没有这个接口' } })
  }

  function isAuthorized(req) {
    if (!token) return true
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    return safeEqual(header.slice('Bearer '.length).trim(), token)
  }

  return server
}

function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest()
  const hb = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(ha, hb)
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  })
  res.end(body)
}

function readJsonBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        tooLarge = true
        chunks.length = 0
        return
      }
      if (!tooLarge) chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, `请求体超过 ${limitBytes} 字节`))
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'))
      }
    })
    req.on('error', (err) => {
      reject(new HttpError(400, `读取请求体失败：${errorText(err)}`))
    })
  })
}
