/**
 * AnyListenSession 的端到端单测。
 *
 * 这里用一个假的 WebSocket 与假的 fetch 驱动**完整的会话**，包括握手、心跳、
 * 重连与 RPC 往返。目的是把「编译通过、装到设备上却不工作」的那类假设
 * 变成本地可断言的检查 —— 这正是本项目历史上反复出问题的地方。
 *
 * 握手校验用**独立的 Node crypto 实现**重算，而不是复用被测的 sha256 模块，
 * 否则「客户端算错、测试也跟着算错」会互相掩盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { AnyListenSession, handshake, buildSocketUrl, normalizeServerUrl } from './client.ts'
import { OP, decodeFrame } from './wire.ts'

const SERVER = 'https://music.example.com'
const PASSWORD = 'Test123.'
const SERVER_ID = 'ef967ec8-f869-4173-8b63-06cdc6bbd6c7'
const TOKEN = 'header.payload.signature'

const nodeSha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 服务端口令校验：用注入的 salt 重算，与真实服务端行为一致。 */
function serverAccepts(salt: string, m: string, password = PASSWORD): boolean {
  return nodeSha256Hex(password + salt) === m
}

interface Recorded {
  url: string
  socket: FakeWebSocket
}

/** 一个足够真实的假 WebSocket：记录收到的帧，并能向客户端注入入站帧。 */
class FakeWebSocket {
  static created: Recorded[] = []

  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  readonly url: string
  sent: string[] = []
  closed = false

  constructor(url: string) {
    this.url = url
    FakeWebSocket.created.push({ url, socket: this })
  }

  send(data: string): void {
    if (this.closed) throw new Error('socket is closed')
    this.sent.push(data)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }

  /** 模拟服务端接受连接。 */
  accept(): void {
    this.onopen?.()
  }

  /** 模拟服务端发来一帧。 */
  emit(data: unknown): void {
    this.onmessage?.({ data })
  }

  /** 取出客户端发出的最后一帧的解析结果。 */
  lastFrame(): unknown[] {
    const raw = this.sent[this.sent.length - 1]
    return JSON.parse(raw) as unknown[]
  }
}

/** 造一个假的 fetch，行为与真实服务端一致。 */
function makeFetch(opts: {
  status?: number
  token?: string | null
  onAuth?: (salt: string, m: string) => void
  failNetwork?: boolean
} = {}): typeof fetch {
  const impl = async (input: any, init?: any): Promise<Response> => {
    if (opts.failNetwork) throw new Error('network down')
    const url = String(input)

    if (url.endsWith('/api/ipc/id')) {
      return new Response(`OjppZDo6-${SERVER_ID}`, { status: 200 })
    }
    if (url.endsWith('/api/ipc/ah')) {
      const headers = (init?.headers ?? {}) as Record<string, string>
      opts.onAuth?.(headers.s, headers.m)
      const status = opts.status ?? 200
      if (status !== 200) return new Response('nope', { status })
      const h = new Headers()
      if (opts.token !== null) h.set('token', opts.token ?? TOKEN)
      return new Response('Hello~::^-^::~v1~\n', { status: 200, headers: h })
    }
    return new Response('not found', { status: 404 })
  }
  return impl as unknown as typeof fetch
}

function makeSession(overrides: Partial<ConstructorParameters<typeof AnyListenSession>[0]> = {}) {
  const states: string[] = []
  const errors: string[] = []
  const session = new AnyListenSession({
    serverUrl: SERVER,
    password: PASSWORD,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    fetchImpl: makeFetch(),
    reconnectBaseMs: 1,
    callTimeoutMs: 200,
    onStateChange: (s) => states.push(s),
    onError: (m) => errors.push(m),
    ...overrides,
  })
  return { session, states, errors }
}

/** 等客户端建好 socket 并 accept 它。 */
async function establish(session: AnyListenSession): Promise<FakeWebSocket> {
  const before = FakeWebSocket.created.length
  await session.connect()
  for (let i = 0; i < 50 && FakeWebSocket.created.length === before; i++) await sleep(2)
  const rec = FakeWebSocket.created[FakeWebSocket.created.length - 1]
  assert.ok(rec, '客户端没有创建 WebSocket')
  rec.socket.accept()
  await sleep(5)
  return rec.socket
}

test.beforeEach(() => {
  FakeWebSocket.created = []
})

// ---------------------------------------------------------------- 握手

test('握手用 sha256(password + salt)，服务端能校验通过', async () => {
  let seenSalt = ''
  let seenM = ''
  const hs = await handshake({
    serverUrl: SERVER,
    password: PASSWORD,
    fetchImpl: makeFetch({ onAuth: (salt, m) => { seenSalt = salt; seenM = m } }),
  })
  assert.equal(hs.ok, true)
  assert.ok(seenSalt.length > 0, '没有发送 salt 头')
  assert.ok(seenM.length > 0, '没有发送 m 头')
  // 用独立实现重算，确认算法一致
  assert.ok(serverAccepts(seenSalt, seenM), '服务端无法用 sha256(password+salt) 校验通过')
})

test('token 取自响应头而不是响应体', async () => {
  const hs = await handshake({ serverUrl: SERVER, password: PASSWORD, fetchImpl: makeFetch() })
  assert.equal(hs.ok, true)
  if (hs.ok) {
    assert.equal(hs.token, TOKEN)
    // 响应体是 Hello~::^-^::~v1~，绝不能被当成 token
    assert.ok(!hs.token.includes('Hello'), 'token 竟然来自响应体')
  }
})

test('缺少 token 头时报错而不是静默继续', async () => {
  const hs = await handshake({
    serverUrl: SERVER,
    password: PASSWORD,
    fetchImpl: makeFetch({ token: null }),
  })
  assert.equal(hs.ok, false)
  if (!hs.ok) assert.match(hs.message, /token/)
})

test('401 报密码错误，403 报封禁', async () => {
  const bad = await handshake({ serverUrl: SERVER, password: 'wrong', fetchImpl: makeFetch({ status: 401 }) })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.match(bad.message, /密码/)

  const blocked = await handshake({ serverUrl: SERVER, password: PASSWORD, fetchImpl: makeFetch({ status: 403 }) })
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.match(blocked.message, /封禁/)
})

test('网络异常不会抛出，而是返回可读失败', async () => {
  const hs = await handshake({
    serverUrl: SERVER,
    password: PASSWORD,
    fetchImpl: makeFetch({ failNetwork: true }),
  })
  assert.equal(hs.ok, false)
  if (!hs.ok) assert.match(hs.message, /无法连接/)
})

test('服务器地址缺少协议时给出明确提示', async () => {
  const hs = await handshake({ serverUrl: 'music.example.com', password: PASSWORD, fetchImpl: makeFetch() })
  assert.equal(hs.ok, false)
  if (!hs.ok) assert.match(hs.message, /https?:\/\//)
})

test('服务器地址末尾斜杠不会造成双斜杠路径', async () => {
  const seen: string[] = []
  const spy = (async (input: any) => {
    seen.push(String(input))
    return new Response('x', { status: 200, headers: { token: TOKEN } })
  }) as unknown as typeof fetch
  await handshake({ serverUrl: 'https://h.example.com/', password: PASSWORD, fetchImpl: spy })
  assert.ok(seen.every((u) => !u.includes('//api')), `路径出现双斜杠: ${seen.join(', ')}`)
})

test('normalizeServerUrl 只去末尾斜杠，保留子路径', () => {
  assert.equal(normalizeServerUrl('https://h.com/'), 'https://h.com')
  assert.equal(normalizeServerUrl('https://h.com/music/'), 'https://h.com/music')
  assert.equal(normalizeServerUrl('  https://h.com  '), 'https://h.com')
})

// ---------------------------------------------------------------- socket 地址

test('WebSocket 地址是 wss 且 token 作为查询参数 m，t=main', () => {
  const url = buildSocketUrl(SERVER, 'a b+c')
  assert.ok(url.startsWith('wss://'), url)
  assert.ok(url.includes('/api/ipc/socket?'), url)
  assert.ok(url.includes('t=main'), url)
  assert.ok(url.includes(`m=${encodeURIComponent('a b+c')}`), url)
})

test('http 服务器地址推导出 ws://', () => {
  assert.ok(buildSocketUrl('http://192.168.1.5:8080', 'tk').startsWith('ws://'))
})

// ---------------------------------------------------------------- 会话

test('连上之后立刻发送 inited（每一段连接都必须发）', async () => {
  const { session } = makeSession()
  const socket = await establish(session)
  assert.equal(socket.sent.length >= 1, true, '连上后没有任何请求')
  const frame = decodeFrame(socket.sent[0])
  assert.equal(frame.kind, 'request')
  if (frame.kind === 'request') {
    assert.deepEqual(frame.path, ['inited'], 'inited 必须是裸方法名，不能是 app.inited')
  }
  session.close()
})

test('inited 的 path 只有一段 —— 点号路径会让服务端抛 ReferenceError', async () => {
  const { session } = makeSession()
  const socket = await establish(session)
  const frame = JSON.parse(socket.sent[0]) as unknown[]
  const path = frame[2] as string[]
  assert.equal(path.length, 1, `path 必须是单段，实际是 ${JSON.stringify(path)}`)
  assert.ok(!path[0].includes('.'), `path 里不能有点号: ${path[0]}`)
  session.close()
})

test('每次重连都会重发 inited（漏发会表现为永远收不到推送）', async () => {
  const { session } = makeSession()
  const sock1 = await establish(session)
  assert.equal(sock1.sent.length >= 1, true)

  // 模拟服务端断开
  sock1.close()
  // 等自动重连并建立第二个连接
  const before = FakeWebSocket.created.length
  for (let i = 0; i < 80 && FakeWebSocket.created.length === before; i++) await sleep(5)
  const rec2 = FakeWebSocket.created[FakeWebSocket.created.length - 1]
  assert.ok(rec2 && rec2.socket !== sock1, '没有发起重连')
  rec2.socket.accept()
  await sleep(10)

  assert.equal(rec2.socket.sent.length >= 1, true, '重连后没有重发 inited')
  session.close()
})

/**
 * 心跳：服务端的纯文本 `ping` 必须被**忽略**，绝不能回文本 `pong`。
 *
 * 这一条是**反转**过来的：早先这里断言「要回 pong」，而那个行为是错的，
 * 也是「每 30 秒重连一次」的原因。
 *
 * 实测（tools/ws-probe-heartbeat.mjs，对着真实服务器）：
 *   什么都不回 → 存活 120s+
 *   回文本 pong → 约 0.2 秒后被服务端以 code=4100 关闭
 *
 * 因为服务端对**任何**字符串都先 `JSON.parse`，失败即 `close(failed)`；
 * `'pong'` 不是合法 JSON。保活实际靠 WebSocket 协议级 ping/pong 帧，
 * 由原生实现自动应答，应用层什么都不用做。
 */
test('心跳：收到纯文本 ping 必须忽略，不能回 pong', async () => {
  const { session } = makeSession()
  const socket = await establish(session)
  const before = socket.sent.length
  socket.emit('ping')
  await sleep(20)
  assert.ok(
    !socket.sent.includes('pong'),
    `回了文本 pong —— 服务端会把它当成非法 JSON 并以 4100 关闭连接。实际发送: ${JSON.stringify(socket.sent.slice(before))}`,
  )
  // 也不该因此多发任何别的帧
  assert.equal(socket.sent.length, before, '处理 ping 时发送了额外帧')
  session.close()
})

test('RPC 成功：发送形状正确并能解出 data', async () => {
  const { session } = makeSession()
  const socket = await establish(session)
  socket.sent = [] // 清掉 inited

  const promise = session.call('getAllUserLists')
  await sleep(5)

  const frame = JSON.parse(socket.sent[0]) as unknown[]
  assert.equal(frame[0], OP.REQUEST)
  assert.deepEqual(frame[2], ['getAllUserLists'])
  assert.deepEqual(frame[3], [])
  assert.deepEqual(frame[4], [])

  socket.emit(JSON.stringify([OP.RESPONSE, frame[1], null, { userList: [1, 2] }]))
  assert.deepEqual(await promise, { userList: [1, 2] })
  session.close()
})

test('RPC 参数按位置传递（getListMusics 要 listId）', async () => {
  const { session } = makeSession()
  const socket = await establish(session)
  socket.sent = []

  // 故意不 await：这里要检查的是发出的帧，响应永不到来。
  // 必须挂一个 catch，否则 session.close() 时这个 promise 会 reject 成
  // unhandledRejection，在 Node 里会让整个测试文件以非零码退出。
  const promise = session.call('getListMusics', 'du3jglgqkj8')
  promise.catch(() => { /* 预期：会话关闭时被 reject */ })
  await sleep(5)

  const frame = JSON.parse(socket.sent[0]) as unknown[]
  assert.deepEqual(frame[2], ['getListMusics'])
  assert.deepEqual(frame[3], ['du3jglgqkj8'])
  session.close()
  await promise.catch(() => { /* 等它 settle，避免跨测试的异步残留 */ })
})

test('RPC 失败：错误 message 会被透出，而不是被吞掉', async () => {
  const { session } = makeSession()
  const socket = await establish(session)
  socket.sent = []

  const promise = session.call('listAction', { action: 'list_update', data: {} })
  await sleep(5)
  const frame = JSON.parse(socket.sent[0]) as unknown[]

  socket.emit(JSON.stringify([OP.RESPONSE, frame[1], { message: 'NOT NULL constraint failed: my_list.meta' }]))
  await assert.rejects(promise, /NOT NULL constraint failed/)
  session.close()
})

test('RPC 超时会 reject，而不是永远挂着', async () => {
  const { session } = makeSession({ callTimeoutMs: 30 })
  await establish(session)
  await assert.rejects(session.call('neverAnswers'), /超时/)
  session.close()
})

test('未连接时调用立刻失败，而不是静默排队', async () => {
  const { session } = makeSession({ fetchImpl: makeFetch({ failNetwork: true }) })
  await session.connect()
  await assert.rejects(session.call('inited'), /连接未就绪/)
  session.close()
})

test('连接断开时挂起的调用会被 reject（否则调用方永远等下去）', async () => {
  const { session } = makeSession()
  const socket = await establish(session)
  socket.sent = []

  const promise = session.call('slowCall')
  await sleep(5)
  socket.close()
  await assert.rejects(promise, /断开/)
  session.close()
})

test('服务端 → 客户端的入站请求会被分派给注册的处理器并回响应', async () => {
  const { session } = makeSession()
  const socket = await establish(session)

  const received: unknown[] = []
  session.on('listAction', (...args) => {
    received.push(args[0])
    return undefined
  })

  socket.emit(JSON.stringify([OP.REQUEST, '77', ['listAction'], [{ action: 'list_create' }], []]))
  await sleep(5)

  assert.deepEqual(received, [{ action: 'list_create' }], '入站请求没有被分派')
  const response = socket.sent.map((s) => JSON.parse(s)).find((f) => f[0] === OP.RESPONSE)
  assert.ok(response, '没有回响应帧')
  assert.equal(response[1], '77')
  session.close()
})

test('入站请求的处理器抛错时回错误帧，而不是让服务端挂住', async () => {
  const { session } = makeSession()
  const socket = await establish(session)
  session.on('boom', () => { throw new Error('handler failed') })

  socket.emit(JSON.stringify([OP.REQUEST, '88', ['boom'], [], []]))
  await sleep(5)

  const response = socket.sent.map((s) => JSON.parse(s)).find((f) => f[0] === OP.RESPONSE)
  assert.ok(response)
  assert.match(String(response[2]?.message), /handler failed/)
  session.close()
})

test('未注册的入站方法也回响应，避免服务端一直待决', async () => {
  const { session } = makeSession()
  const socket = await establish(session)
  socket.emit(JSON.stringify([OP.REQUEST, '99', ['playerEvent'], [{ x: 1 }], []]))
  await sleep(5)
  const response = socket.sent.map((s) => JSON.parse(s)).find((f) => f[0] === OP.RESPONSE)
  assert.ok(response, '未注册方法没有回响应')
  session.close()
})

test('鉴权失败时不进入重连循环（否则会反复触发服务端封 IP）', async () => {
  const { session, states } = makeSession({ fetchImpl: makeFetch({ status: 401 }) })
  await session.connect()
  await sleep(60)
  assert.equal(session.getState(), 'closed')
  assert.ok(!states.includes('connected'), '鉴权失败却建立了连接')
  session.close()
})

test('close() 之后不再重连', async () => {
  const { session } = makeSession()
  const socket = await establish(session)
  session.close()
  const count = FakeWebSocket.created.length
  socket.close()
  await sleep(50)
  assert.equal(FakeWebSocket.created.length, count, 'close() 之后仍在重连')
})

// ------------------------------------------------- connect() 的时序契约

/**
 * 这三条锁定一个曾导致「门禁提前放行」的时序陷阱。
 *
 * `connect()` 内部只是调 `openSocket()`，而 socket 的 `onopen` 是**异步**回调，
 * 所以 `connect()` resolve 时连接**还没建立**。任何把 `connect()` 的结果
 * 当作「已连接」的代码都会提前放行，随后的 RPC 照样失败 —— 而表面上
 * 一切「成功」。播放门禁 `global.lx.apiInitPromise` 正是踩过这个坑，
 * 修法是改用 `api.ts` 里轮询到 `connected` 的 `waitForConnected()`。
 */

test('connect() 在 socket open 之前就 resolve（不能拿它当已连接）', async () => {
  const { session } = makeSession()
  await session.connect()

  // 此刻握手已完成、socket 已创建，但服务端还没接受连接
  assert.notEqual(session.getState(), 'connected',
    'connect() 竟然在 open 之前就把状态置为 connected —— 时序契约变了')

  const rec = FakeWebSocket.created[FakeWebSocket.created.length - 1]
  assert.ok(rec, '客户端没有创建 WebSocket')

  rec.socket.accept()
  await sleep(5)
  assert.equal(session.getState(), 'connected', 'accept() 之后仍不是 connected')
  session.close()
})

test('socket open 之前发起 RPC 必须失败（证明「已连接」是真实前提）', async () => {
  const { session } = makeSession()
  await session.connect()
  assert.notEqual(session.getState(), 'connected')

  // 未连接时 call() 应立刻拒绝，而不是静默挂起或假装成功
  await assert.rejects(
    () => session.call('getAllUserLists'),
    /连接未就绪/,
    '未连接时 RPC 没有立即失败',
  )

  const rec = FakeWebSocket.created[FakeWebSocket.created.length - 1]
  rec?.socket.accept()
  await sleep(5)
  session.close()
})

test('握手失败时状态为 closed，用于让等待方立刻放弃而不是等到超时', async () => {
  const { session } = makeSession({ fetchImpl: makeFetch({ status: 401 }) })
  await session.connect()
  assert.equal(session.getState(), 'closed')
  session.close()
})
