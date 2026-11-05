/**
 * 中转内部的错误分类。
 *
 * 分类的唯一目的，是让 HTTP 层决定「这个请求该不该让客户端重试」：
 * - RpcError：上游明确返回的业务错误（密码错、歌单不存在、没装音源…），重试没用；
 * - BackendUnavailableError：上游连接还没好/刚断，重试有用；
 * - RpcTimeoutError：已经发出去但上游没回，重试可能有用；
 * - AuthError：上游密码/IP 封禁，属于配置问题，重试没用。
 */

export class RelayError extends Error {
  constructor(message, code, retryable = false) {
    super(message)
    this.name = new.target.name
    this.code = code
    this.retryable = retryable
  }
}

export class RpcError extends RelayError {
  constructor(message) {
    super(message, 'RPC_ERROR', false)
  }
}

export class BackendUnavailableError extends RelayError {
  constructor(message) {
    super(message, 'BACKEND_UNAVAILABLE', true)
  }
}

export class RpcTimeoutError extends RelayError {
  constructor(message) {
    super(message, 'RPC_TIMEOUT', true)
  }
}

export class AuthError extends RelayError {
  constructor(message, status = 401) {
    super(message, 'BACKEND_AUTH_FAILED', false)
    this.status = status
  }
}

export class StoppedError extends RelayError {
  constructor(message = '中转后端已停止') {
    super(message, 'RELAY_STOPPED', true)
  }
}

export function errorText(err) {
  if (err instanceof Error) return err.message
  return String(err)
}
