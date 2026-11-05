import assert from 'node:assert/strict'
import test from 'node:test'

import { BackendUnavailableError, RpcError, RpcTimeoutError } from '../lib/errors.mjs'
import { createRelayServer } from '../lib/http.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

async function startServer(backend, options = {}) {
  const server = createRelayServer({
    backend,
    token: 'secret',
    logger: silent,
    version: 'test',
    ...options,
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return { server, base }
}

function closeServer(server) {
  server.closeAllConnections?.()
  server.close()
}

const authHeaders = { Authorization: 'Bearer secret' }

test('没有令牌时拒绝访问', async (t) => {
  const backend = { health: () => ({ connected: true }), call: async () => null }
  const { server, base } = await startServer(backend)
  t.after(() => closeServer(server))

  const res = await fetch(`${base}/healthz`)
  assert.equal(res.status, 401)
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'UNAUTHORIZED')

  const wrong = await fetch(`${base}/healthz`, { headers: { Authorization: 'Bearer nope' } })
  assert.equal(wrong.status, 401)
})

test('GET /healthz 返回后端状态', async (t) => {
  const backend = {
    health: () => ({ connected: false, state: 'connecting', serverId: 'sid', lastError: '连接中断' }),
    call: async () => null,
  }
  const { server, base } = await startServer(backend)
  t.after(() => closeServer(server))

  const res = await fetch(`${base}/healthz`, { headers: authHeaders })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.connected, false)
  assert.equal(body.serverId, 'sid')
  assert.equal(body.relayVersion, 'test')
})

test('POST /rpc 转发 method 与 args 并返回 data', async (t) => {
  let received = null
  const backend = {
    health: () => ({ connected: true }),
    call: async (method, args, options) => {
      received = { method, args, options }
      return [{ id: 'm1' }]
    },
  }
  const { server, base } = await startServer(backend)
  t.after(() => closeServer(server))

  const res = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'getListMusics', args: ['list-1'] }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body, { ok: true, data: [{ id: 'm1' }] })
  assert.equal(received.method, 'getListMusics')
  assert.deepEqual(received.args, ['list-1'])
})

test('上游业务错误返回 200 + ok:false（客户端不重试）', async (t) => {
  const backend = {
    health: () => ({ connected: true }),
    call: async () => { throw new RpcError('没有这个歌单') },
  }
  const { server, base } = await startServer(backend)
  t.after(() => closeServer(server))

  const res = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'getListMusics', args: ['x'] }),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'RPC_ERROR')
  assert.equal(body.error.message, '没有这个歌单')
})

test('后端未连接 / 超时返回可重试的 503 / 504', async (t) => {
  let mode = 'unavailable'
  const backend = {
    health: () => ({ connected: false }),
    call: async () => {
      throw mode === 'unavailable'
        ? new BackendUnavailableError('后端在等待重连期间未就绪')
        : new RpcTimeoutError('调用 getMusicUrl 超时')
    },
  }
  const { server, base } = await startServer(backend)
  t.after(() => closeServer(server))

  const request = {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'getMusicUrl', args: [{}] }),
  }

  const unavailable = await fetch(`${base}/rpc`, request)
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.headers.get('retry-after'), '2')
  assert.equal((await unavailable.json()).error.retryable, true)

  mode = 'timeout'
  const timeout = await fetch(`${base}/rpc`, request)
  assert.equal(timeout.status, 504)
  assert.equal((await timeout.json()).error.code, 'RPC_TIMEOUT')
})

test('参数不合法 / 方法不对 / 路径不存在', async (t) => {
  const backend = { health: () => ({ connected: true }), call: async () => null }
  const { server, base } = await startServer(backend)
  t.after(() => closeServer(server))

  const noMethod = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ args: [] }),
  })
  assert.equal(noMethod.status, 400)

  const badArgs = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'x', args: {} }),
  })
  assert.equal(badArgs.status, 400)

  const badJson = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: '{',
  })
  assert.equal(badJson.status, 400)

  const wrongMethod = await fetch(`${base}/rpc`, { headers: authHeaders })
  assert.equal(wrongMethod.status, 405)

  const notFound = await fetch(`${base}/nope`, { headers: authHeaders })
  assert.equal(notFound.status, 404)
})
