/**
 * any-listen 的 `message2call` 线上帧编解码。
 *
 * ## 帧格式是数组，不是对象
 *
 * 这一点是读**线上部署的 bundle**（`view-main.ipc.CSIblLLr.js`）确认的，不是猜的：
 *
 * ```
 * 请求      [0, callId, path, args, callbacks]
 * 响应      [1, callId, {message, stack?}]      错误
 *           [1, callId, null, data]             成功
 * 回调请求  [2, callId, content]
 * 回调响应  [3, callId, content]
 * ```
 *
 * ⚠️ npm 上的 `message2call@0.1.3` 用的是**对象**帧（`{name, path, data}`），
 * **与服务端不兼容**。照 npm 版本实现会每个调用都超时，因为服务端的 `message()`
 * 对非数组输入直接 `throw Error('message is not array')`，而这个异常被吞掉了 ——
 * 表现是「握手成功、WebSocket 连上、但每个 RPC 都静默超时」。
 *
 * 本模块是纯函数，不依赖 React Native，因此可被 `node --test` 直接覆盖。
 */

/** 帧操作码。服务端 `message2call` 的取值。 */
export const OP = {
  REQUEST: 0,
  RESPONSE: 1,
  CALLBACK_REQUEST: 2,
  CALLBACK_RESPONSE: 3,
} as const

export type OpCode = (typeof OP)[keyof typeof OP]

/** 服务端返回的错误对象形状。 */
export interface WireError {
  message: string
  stack?: string
}

/** 解析后的响应帧。 */
export type DecodedResponse =
  | { kind: 'response'; callId: string; ok: true; data: unknown }
  | { kind: 'response'; callId: string; ok: false; error: WireError }
  | { kind: 'callback-request'; callId: string; content: unknown }
  | { kind: 'callback-response'; callId: string; content: unknown }
  | { kind: 'request'; callId: string; path: string[]; args: unknown[]; callbacks: unknown[] }
  | { kind: 'unknown'; raw: unknown }

/**
 * 编码一个请求帧。
 *
 * `path` 是**字符串数组，且必须只有一段**。
 * 服务端用平铺工厂拼调度对象：
 *   `const exposeObj = { ...createExposeApp(), ...createExposeList(), ...createExposeMusic() }`
 * 所以不存在 `exposeObj.list` 可下钻。写成 `['list', 'getAllUserLists']` 会让服务端
 * 在 `undefined` 上取属性并抛 `ReferenceError`，日志里就是字面的 `list is not defined`。
 *
 * 客户端**不要**自己传 socket：服务端注册时通过
 * `onCallBeforeParams(rawArgs) { return [socket, ...rawArgs] }` 自己注入。
 */
export function encodeRequest(callId: string, path: string[], args: unknown[]): string {
  return JSON.stringify([OP.REQUEST, callId, path, args, []])
}

/** 编码一个客户端回调响应帧。 */
export function encodeCallbackResponse(callId: string, content: unknown): string {
  return JSON.stringify([OP.CALLBACK_RESPONSE, callId, content])
}

/** 解析一个入站帧。任何无法识别的输入都归为 `unknown`，绝不抛出。 */
export function decodeFrame(raw: unknown): DecodedResponse {
  if (typeof raw !== 'string') return { kind: 'unknown', raw }

  let frame: unknown
  try {
    frame = JSON.parse(raw)
  } catch {
    // 服务端会发纯文本 'ping' 之类的非 JSON 内容，解析失败是正常路径而非错误
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
        path: Array.isArray(frame[2]) ? (frame[2] as string[]) : [],
        args: Array.isArray(frame[3]) ? (frame[3] as unknown[]) : [],
        callbacks: Array.isArray(frame[4]) ? (frame[4] as unknown[]) : [],
      }
    case OP.RESPONSE: {
      // 错误帧是 [1, id, {message, stack}]（第 3 项是错误对象，没有第 4 项）
      // 成功帧是 [1, id, null, data]
      const errSlot = frame[2]
      if (errSlot !== null && errSlot !== undefined) {
        const wireError =
          typeof errSlot === 'object' && errSlot !== null
            ? (errSlot as WireError)
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

/**
 * 心跳专用：服务端发的纯文本 ping。
 *
 * 服务端每 30s 检查，超过 45s 无活动就 `terminate()`，超过 15s 发 WebSocket ping，
 * 并**另外**发一条纯文本 `"ping"`。客户端必须回 `"pong"`。
 * 漏掉的后果是连接被服务端静默掐断（不报错，表现为随机时刻开始所有请求超时）。
 */
export const PING_TEXT = 'ping'
export const PONG_TEXT = 'pong'

/** 判断一个入站原始值是否是心跳 ping。 */
export function isPing(raw: unknown): boolean {
  return raw === PING_TEXT
}
