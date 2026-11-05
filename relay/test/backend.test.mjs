import assert from 'node:assert/strict'
import test from 'node:test'

import { AnyListenBackend } from '../lib/backend.mjs'
import { sha256Hex } from '../lib/protocol.mjs'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

class FakeWebSocket {
  static instances = []

  static reset() {
    FakeWebSocket.instances = []
  }

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  emit(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event)
  }

  send(data) {
    if (this.readyState !== 1) throw new Error('socket is not open')
    this.sent.push(data)
  }

  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', { code: 1000 })
  }

  open() {
    this.readyState = 1
    this.emit('open', {})
  }

  message(data) {
    this.emit('message', { data })
  }

  serverClose(code = 1006) {
    this.readyState = 3
    this.emit('close', { code })
  }
}

function makeFetch({ token = 'tok', serverId = 'sid', status = 200 } = {}) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url, init })
    if (url.endsWith('/api/ipc/ah')) {
      if (status !== 200) {
        return { ok: false, status, headers: { get: () => null }, text: async () => '' }
      }
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === 'token' ? token : null) },
        text: async () => 'Hello~::^-^::~v1~\n',
      }
    }
    if (url.endsWith('/api/ipc/id')) {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => `OjppZDo6-${serverId}` }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }
  return { impl, calls }
}

function makeBackend(overrides = {}) {
  const fetch = makeFetch()
  const backend = new AnyListenBackend({
    serverUrl: 'http://127.0.0.1:8080',
    password: 'pw',
    fetchImpl: fetch.impl,
    WebSocketImpl: FakeWebSocket,
    reconnectBaseMs: 5,
    reconnectMaxMs: 20,
    random: () => 0,
    connectTimeoutMs: 100,
    callTimeoutMs: 200,
    waitForReadyMs: 300,
    heartbeatCheckMs: 10_000,
    logger: silent,
    ...overrides,
  })
  return { backend, fetch }
}

async function waitFor(predicate, timeout = 1_000, label = 'condition') {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) throw new Error(`等待超时：${label}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function framesOf(ws) {
  return ws.sent.map((raw) => JSON.parse(raw))
}

test('握手成功后建立 WS，RPC 能往返', async (t) => {
  FakeWebSocket.reset()
  const { backend, fetch } = makeBackend()
  t.after(() => backend.stop())

  backend.start()
  await waitFor(() => FakeWebSocket.instances.length === 1, 1_000, 'WS 建立')
  const ws = FakeWebSocket.instances[0]
  assert.match(ws.url, /\/api\/ipc\/socket\?m=tok&t=main$/)

  const handshake = fetch.calls.find((call) => call.url.endsWith('/api/ipc/ah'))
  assert.equal(handshake.init.method, 'POST')
  assert.equal(handshake.init.headers.m, sha256Hex(`pw${handshake.init.headers.s}`))

  ws.open()
  await waitFor(() => backend.connected, 1_000, '连接就绪')
  await tick()

  const inited = framesOf(ws).find((frame) => frame[2]?.[0] === 'inited')
  assert.ok(inited, '每次连上都要发 inited')
  ws.message(JSON.stringify([1, inited[1], null, null]))

  const pending = backend.call('getListMusics', ['list-1'])
  await tick()
  const request = framesOf(ws).find((frame) => frame[2]?.[0] === 'getListMusics')
  assert.deepEqual(request[3], ['list-1'])
  ws.message(JSON.stringify([1, request[1], null, [{ id: 'm1' }]]))
  assert.deepEqual(await pending, [{ id: 'm1' }])
})

test('未连接时的调用排队，连上后自动补发', async (t) => {
  FakeWebSocket.reset()
  const { backend } = makeBackend()
  t.after(() => backend.stop())

  backend.start()
  await waitFor(() => FakeWebSocket.instances.length === 1, 1_000, 'WS 建立')

  const pending = backend.call('getAllUserLists', [])
  let settled = false
  pending.then(() => { settled = true }, () => { settled = true })
  await tick()
  assert.equal(settled, false, '连接未就绪时不能立刻失败')

  const ws = FakeWebSocket.instances[0]
  ws.open()
  await waitFor(() => backend.connected, 1_000, '连接就绪')
  await tick()

  const request = framesOf(ws).find((frame) => frame[2]?.[0] === 'getAllUserLists')
  assert.ok(request)
  ws.message(JSON.stringify([1, request[1], null, { userList: [] }]))
  assert.deepEqual(await pending, { userList: [] })
})

test('文本 ping 被忽略，业务错误按错误 reject', async (t) => {
  FakeWebSocket.reset()
  const { backend } = makeBackend()
  t.after(() => backend.stop())

  backend.start()
  await waitFor(() => FakeWebSocket.instances.length === 1, 1_000, 'WS 建立')
  const ws = FakeWebSocket.instances[0]
  ws.open()
  await waitFor(() => backend.connected, 1_000, '连接就绪')
  await tick()

  // 回 pong 会被服务端判协议错误，这里只验证中转不会因此断开
  ws.message('ping')
  assert.equal(backend.connected, true)

  const pending = backend.call('getListMusics', ['missing'])
  await tick()
  const request = framesOf(ws).find((frame) => frame[2]?.[0] === 'getListMusics')
  ws.message(JSON.stringify([1, request[1], { message: '没有这个歌单' }]))
  await assert.rejects(pending, /没有这个歌单/)
  assert.equal(backend.connected, true)
})

test('服务端 → 中转入站请求用 op 1 应答，回调请求用 op 3', async (t) => {
  FakeWebSocket.reset()
  const { backend } = makeBackend()
  t.after(() => backend.stop())

  backend.start()
  await waitFor(() => FakeWebSocket.instances.length === 1, 1_000, 'WS 建立')
  const ws = FakeWebSocket.instances[0]
  ws.open()
  await waitFor(() => backend.connected, 1_000, '连接就绪')
  await tick()

  ws.message(JSON.stringify([0, 'srv-1', ['listAction'], [{ action: 'add' }], []]))
  ws.message(JSON.stringify([2, 'cb-1', { payload: 1 }]))
  await tick()

  const frames = framesOf(ws)
  assert.deepEqual(
    frames.find((frame) => frame[1] === 'srv-1'),
    [1, 'srv-1', null, null],
    '入站请求必须回 op 1，否则上游会一直挂着',
  )
  assert.deepEqual(
    frames.find((frame) => frame[1] === 'cb-1'),
    [3, 'cb-1', null],
    '回调请求回 op 3',
  )
})

test('WS 断开时拒绝在途调用，重连复用 token（不重复握手）', async (t) => {
  FakeWebSocket.reset()
  const fetch = makeFetch()
  const backend = new AnyListenBackend({
    serverUrl: 'http://127.0.0.1:8080',
    password: 'pw',
    fetchImpl: fetch.impl,
    WebSocketImpl: FakeWebSocket,
    reconnectBaseMs: 5,
    reconnectMaxMs: 20,
    random: () => 0,
    connectTimeoutMs: 100,
    callTimeoutMs: 500,
    waitForReadyMs: 300,
    logger: silent,
  })
  t.after(() => backend.stop())

  backend.start()
  await waitFor(() => FakeWebSocket.instances.length === 1, 1_000, '第一次 WS')
  const first = FakeWebSocket.instances[0]
  first.open()
  await waitFor(() => backend.connected, 1_000, '连接就绪')
  await tick()

  const pending = backend.call('getMusicUrl', [{ id: 'm1' }])
  await tick()
  first.serverClose(1006)
  await assert.rejects(pending, /连接已断开/)

  await waitFor(() => FakeWebSocket.instances.length === 2, 1_000, '重连 WS')
  const second = FakeWebSocket.instances[1]
  assert.equal(second.url, first.url, '重连应复用同一个 token')
  assert.equal(fetch.calls.filter((call) => call.url.endsWith('/api/ipc/ah')).length, 1)
})

test('上游密码错误时进入 auth-failed，且不再自动重试', async (t) => {
  FakeWebSocket.reset()
  const fetch = makeFetch({ status: 401 })
  const backend = new AnyListenBackend({
    serverUrl: 'http://127.0.0.1:8080',
    password: 'wrong',
    fetchImpl: fetch.impl,
    WebSocketImpl: FakeWebSocket,
    reconnectBaseMs: 5,
    reconnectMaxMs: 20,
    random: () => 0,
    logger: silent,
  })
  t.after(() => backend.stop())

  backend.start()
  await waitFor(() => backend.state === 'auth-failed', 1_000, '鉴权失败')
  assert.match(backend.health().lastError, /密码错误/)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(FakeWebSocket.instances.length, 0)
})

test('stop() 会拒绝排队中的调用并清理定时器', async (t) => {
  FakeWebSocket.reset()
  const { backend } = makeBackend()
  backend.start()
  await waitFor(() => FakeWebSocket.instances.length === 1, 1_000, 'WS 建立')
  const pending = backend.call('getAllUserLists', [])
  backend.stop()
  await assert.rejects(pending, /已停止/)
  assert.equal(backend.health().queued, 0)
})
