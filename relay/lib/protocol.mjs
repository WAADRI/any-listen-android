/**
 * any-listen 的 `message2call` 线上协议（中转服务侧）。
 *
 * 这些常量与 App 侧 `src/utils/anylisten/wire.ts`、`client.ts` 是**同一份协议**。
 * 之所以在这里重新实现一遍而不是 import App 的 TS：中转服务要能单独拷到
 * 任何一台装了 Node 的机器上运行，不能依赖 React Native 的构建链。
 * 两边的一致性由 `relay/test/protocol.test.mjs` 里的固定帧断言和
 * App 侧 `wire.test.ts` 共同盯住。
 *
 * 帧格式（读线上 bundle 确认，不是按 npm 上 message2call 的对象帧猜的）：
 *
 *   请求      [0, callId, path, args, callbacks]
 *   响应      [1, callId, {message, stack?}]      错误
 *             [1, callId, null, data]             成功
 *   回调请求  [2, callId, content]
 *   回调响应  [3, callId, content]
 *
 * 服务端对**任何**非 JSON 文本都会先刷新 aliveTime、再 JSON.parse；
 * 解析失败就 close(4100)。所以收到文本 `ping` 时什么都不回 ——
 * 回 `pong` 会被判成协议错误并断开。保活靠 WebSocket 协议级 ping/pong。
 */
import { createHash, randomBytes } from 'node:crypto'

export const API_PREFIX = '/api'
export const IPC_PATH = '/ipc'
export const SOCKET_PATH = '/ipc/socket'

export const OP = {
  REQUEST: 0,
  RESPONSE: 1,
  CALLBACK_REQUEST: 2,
  CALLBACK_RESPONSE: 3,
}

/** 服务端定时发来的纯文本心跳。只用于刷新 lastInboundAt，绝不回复。 */
export const PING_TEXT = 'ping'

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function randomHex(bytes) {
  return randomBytes(bytes).toString('hex')
}

/** 去掉末尾斜杠；中转与上游地址都按这个形式拼接。 */
export function normalizeServerUrl(input) {
  return String(input ?? '').trim().replace(/\/+$/, '')
}

/** 由 HTTP(S) 地址推导 WebSocket 地址，token 放在查询参数 `m`。 */
export function buildSocketUrl(serverUrl, token) {
  const base = normalizeServerUrl(serverUrl)
  const ws = base.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://')
  return `${ws}${API_PREFIX}${SOCKET_PATH}?m=${encodeURIComponent(token)}&t=main`
}

/** 编码一个 RPC 请求。path 只有一段，参数放 args。 */
export function encodeRequest(callId, method, args) {
  return JSON.stringify([OP.REQUEST, callId, [method], args ?? [], []])
}

/** 编码回调响应。服务端的广播/回调请求只需要一个应答，内容无用。 */
export function encodeCallbackResponse(callId, content = null) {
  return JSON.stringify([OP.CALLBACK_RESPONSE, callId, content])
}

/**
 * 编码**对入站请求的响应**（op 1），与服务端 → 客户端的调用配对。
 *
 * 注意不能拿 `encodeCallbackResponse`（op 3）来答复 op 0 的请求：
 * 两者是 message2call 里不同的两套通道，op 3 只会被当成「某个回调的响应」，
 * 原请求在对端会一直挂着。
 */
export function encodeResponse(callId, error = null, data = null) {
  return JSON.stringify([OP.RESPONSE, callId, error, data])
}

/**
 * 解析入站帧。任何无法识别的输入都归为 unknown，绝不抛错：
 * 服务端的 `ping` 就是走这条路径的。
 */
export function decodeFrame(raw) {
  if (typeof raw !== 'string') return { kind: 'unknown', raw }

  let frame
  try {
    frame = JSON.parse(raw)
  } catch {
    return { kind: 'unknown', raw }
  }

  if (!Array.isArray(frame) || frame.length < 2) return { kind: 'unknown', raw: frame }

  const op = frame[0]
  const callId = String(frame[1])

  switch (op) {
    case OP.REQUEST:
      return {
        kind: 'request',
        callId,
        path: Array.isArray(frame[2]) ? frame[2] : [],
        args: Array.isArray(frame[3]) ? frame[3] : [],
        callbacks: Array.isArray(frame[4]) ? frame[4] : [],
      }
    case OP.RESPONSE: {
      const errSlot = frame[2]
      if (errSlot !== null && errSlot !== undefined) {
        const wireError =
          typeof errSlot === 'object' && errSlot !== null
            ? errSlot
            : { message: String(errSlot) }
        return { kind: 'response', callId, ok: false, error: wireError }
      }
      return { kind: 'response', callId, ok: true, data: frame[3] }
    }
    case OP.CALLBACK_REQUEST:
      return { kind: 'callback-request', callId, content: frame[2] }
    case OP.CALLBACK_RESPONSE:
      return { kind: 'callback-response', callId, content: frame[2] }
    default:
      return { kind: 'unknown', raw: frame }
  }
}
