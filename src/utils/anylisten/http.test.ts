import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AnyListenHttpSession,
  RelayHttpError,
  fetchRelayHealth,
  normalizeRelayUrl,
  probeRelay,
} from './http.ts'
import type { ConnState } from './client.ts'

type FetchCall = { url: string, init?: RequestInit }

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async() => text,
  } as unknown as Response
}

function makeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  const impl = async(url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { impl: impl as unknown as typeof fetch, calls }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('normalizeRelayUrl 去掉末尾斜杠和空白', () => {
  assert.equal(normalizeRelayUrl(' http://192.168.1.2:8099/// '), 'http://192.168.1.2:8099')
  assert.equal(normalizeRelayUrl(undefined), '')
})

test('fetchRelayHealth 带令牌并解析后端状态', async() => {
  const { impl, calls } = makeFetch(() => jsonResponse(200, {
    ok: true,
    connected: true,
    state: 'connected',
    serverId: 'server-1',
    lastError: '',
  }))

  const health = await fetchRelayHealth({
    relayUrl: 'http://relay.local/',
    relayToken: 'secret',
    fetchImpl: impl,
  })
  assert.equal(health.connected, true)
  assert.equal(health.serverId, 'server-1')
  assert.equal(calls[0].url, 'http://relay.local/healthz')
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer secret')
})

test('fetchRelayHealth 把 401 当成不可重试的配置错误', async() => {
  const { impl } = makeFetch(() => jsonResponse(401, { ok: false }))
  await assert.rejects(
    fetchRelayHealth({ relayUrl: 'http://relay.local', relayToken: 'bad', fetchImpl: impl }),
    (err: unknown) => err instanceof RelayHttpError && err.status === 401 && !err.retryable,
  )
})

test('HTTP 会话：call 发 POST /rpc 并返回 data', async(t) => {
  const { impl, calls } = makeFetch((url) => {
    if (url.endsWith('/healthz')) return jsonResponse(200, { ok: true, connected: true })
    return jsonResponse(200, { ok: true, data: { list: [{ id: 'm1' }] } })
  })
  const session = new AnyListenHttpSession({
    serverUrl: 'http://music.local',
    relayUrl: 'http://relay.local',
    relayToken: 'secret',
    fetchImpl: impl,
    retryBaseMs: 1,
  })
  t.after(() => session.close())

  await session.connect()
  assert.equal(session.getState(), 'connected')
  assert.equal(session.serverUrl, 'http://music.local')

  const data = await session.call<{ list: Array<{ id: string }> }>('getListMusics', 'list-1')
  assert.deepEqual(data, { list: [{ id: 'm1' }] })

  const rpc = calls.find((call) => call.url.endsWith('/rpc'))
  assert.ok(rpc)
  assert.equal(rpc!.init?.method, 'POST')
  assert.equal((rpc!.init?.headers as Record<string, string>).Authorization, 'Bearer secret')
  assert.deepEqual(JSON.parse(String(rpc!.init?.body)), {
    method: 'getListMusics',
    args: ['list-1'],
  })
})

test('HTTP 会话：业务错误立即 reject，不重试', async(t) => {
  let rpcCount = 0
  const { impl } = makeFetch((url) => {
    if (url.endsWith('/healthz')) return jsonResponse(200, { ok: true, connected: true })
    rpcCount += 1
    return jsonResponse(200, { ok: false, error: { code: 'RPC_ERROR', message: '没有这个歌单' } })
  })
  const session = new AnyListenHttpSession({
    serverUrl: 'http://music.local',
    relayUrl: 'http://relay.local',
    fetchImpl: impl,
    retryBaseMs: 1,
  })
  t.after(() => session.close())

  await session.connect()
  await assert.rejects(session.call('getListMusics', 'missing'), /没有这个歌单/)
  assert.equal(rpcCount, 1)
})

test('HTTP 会话：503 会重试，随后成功', async(t) => {
  let rpcCount = 0
  const { impl } = makeFetch((url) => {
    if (url.endsWith('/healthz')) return jsonResponse(200, { ok: true, connected: true })
    rpcCount += 1
    if (rpcCount === 1) return jsonResponse(503, { ok: false, error: { message: '重连中', retryable: true } })
    return jsonResponse(200, { ok: true, data: 'ok' })
  })
  const session = new AnyListenHttpSession({
    serverUrl: 'http://music.local',
    relayUrl: 'http://relay.local',
    fetchImpl: impl,
    retryBaseMs: 1,
    callTimeoutMs: 3_000,
  })
  t.after(() => session.close())

  await session.connect()
  assert.equal(await session.call('getMusicUrl', {}), 'ok')
  assert.equal(rpcCount, 2)
})

test('HTTP 会话：写操作 listAction 失败不自动重试（避免重复执行）', async(t) => {
  let rpcCount = 0
  const { impl } = makeFetch((url) => {
    if (url.endsWith('/healthz')) return jsonResponse(200, { ok: true, connected: true })
    rpcCount += 1
    return jsonResponse(503, { ok: false, error: { message: '重连中', retryable: true } })
  })
  const session = new AnyListenHttpSession({
    serverUrl: 'http://music.local',
    relayUrl: 'http://relay.local',
    fetchImpl: impl,
    retryBaseMs: 1,
  })
  t.after(() => session.close())

  await session.connect()
  await assert.rejects(session.call('listAction', { action: 'add', data: {} }), /暂时不可用/)
  assert.equal(rpcCount, 1)
})

test('HTTP 会话：令牌错误进入 closed，不再重试', async(t) => {
  let rpcCount = 0
  const { impl } = makeFetch((url) => {
    if (url.endsWith('/healthz')) return jsonResponse(200, { ok: true, connected: true })
    rpcCount += 1
    return jsonResponse(401, { ok: false })
  })
  const session = new AnyListenHttpSession({
    serverUrl: 'http://music.local',
    relayUrl: 'http://relay.local',
    relayToken: 'bad',
    fetchImpl: impl,
  })
  t.after(() => session.close())

  await session.connect()
  await assert.rejects(session.call('getAllUserLists'), /令牌无效/)
  assert.equal(session.getState(), 'closed')
  assert.equal(rpcCount, 1)
})

test('HTTP 会话：后端未连接时保持 connecting 并安排重试', async(t) => {
  const { impl } = makeFetch(() => jsonResponse(200, {
    ok: true,
    connected: false,
    state: 'connecting',
    lastError: '连接已断开',
  }))
  const session = new AnyListenHttpSession({
    serverUrl: 'http://music.local',
    relayUrl: 'http://relay.local',
    fetchImpl: impl,
    retryBaseMs: 10_000,
  })
  t.after(() => session.close())

  await session.connect()
  assert.equal(session.getState(), 'connecting')
})

test('HTTP 会话：health 401 直接 closed（令牌配置错误）', async(t) => {
  const { impl } = makeFetch(() => jsonResponse(401, { ok: false }))
  const session = new AnyListenHttpSession({
    serverUrl: 'http://music.local',
    relayUrl: 'http://relay.local',
    relayToken: 'bad',
    fetchImpl: impl,
  })
  t.after(() => session.close())

  await session.connect()
  assert.equal(session.getState(), 'closed')
})

test('probeRelay 把网络错误压成可展示的一行结论', async() => {
  const { impl } = makeFetch(() => { throw new Error('ECONNREFUSED') })
  const result = await probeRelay({ relayUrl: 'http://relay.local', fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.equal(result.status, 0)
  assert.match(result.message, /ECONNREFUSED/)
})

test('HTTP 会话 close 后 call 立即失败', async() => {
  const { impl } = makeFetch(() => jsonResponse(200, { ok: true, connected: true }))
  const session = new AnyListenHttpSession({
    serverUrl: 'http://music.local',
    relayUrl: 'http://relay.local',
    fetchImpl: impl,
  })
  session.close()
  await assert.rejects(session.call('getAllUserLists'), /已关闭/)
  await tick()
  assert.equal(session.getState(), 'closed' as ConnState)
})
