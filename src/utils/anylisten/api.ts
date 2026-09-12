/**
 * any-listen 的数据访问层。
 *
 * 这一层把服务端的方法映射成语义化、带类型的调用，并负责会话的建立与复用。
 * 它**只做转发与形状转换**，不做业务判断 —— 业务判断在源适配器里。
 *
 * 会话按「服务器地址 + 密码」缓存：用户改了配置就自动换一个新会话，
 * 而不是继续用旧连接（那会表现为「改了地址但仍在读旧服务器」）。
 */
import { AnyListenSession, type ConnState } from './client'
import type {
  AnyListenMusicInfo,
  AnyListenMusicUrlInfo,
  AnyListenMusicPicInfo,
  AnyListenMusicLyricResult,
  AnyListenMyAllList,
  AnyListenMusicList,
} from './types'

/** 取服务器地址与访问密码的注入口，便于测试与解耦 store。 */
export interface AnyListenCredentials {
  serverUrl: string
  password: string
}

let session: AnyListenSession | null = null
let sessionKey = ''
let credentialsProvider: (() => AnyListenCredentials) | null = null
let onStateChange: ((state: ConnState, detail?: string) => void) | null = null
let onError: ((message: string) => void) | null = null

/**
 * 注入凭据来源。必须在第一次使用前调用（在 `core/init` 里做）。
 *
 * 之所以用注入而不是直接 import 设置 store：这一层要保持可在 Node 下单测，
 * 而 store 会把整个 app 的依赖树（React Native、主题、i18n…）拖进来。
 */
export function setupAnyListen(options: {
  getCredentials: () => AnyListenCredentials
  onStateChange?: (state: ConnState, detail?: string) => void
  onError?: (message: string) => void
}): void {
  credentialsProvider = options.getCredentials
  onStateChange = options.onStateChange ?? null
  onError = options.onError ?? null
}

/** 当前是否已配置服务器。未配置时不应发起任何请求。 */
export function isConfigured(): boolean {
  const c = credentialsProvider?.()
  return !!c?.serverUrl?.trim()
}

function requireCredentials(): AnyListenCredentials {
  const c = credentialsProvider?.()
  if (!c?.serverUrl?.trim()) {
    throw new Error('尚未配置 any-listen 服务器地址')
  }
  return c
}

/**
 * 取得（必要时创建）当前会话。
 *
 * 凭据变化时旧会话会被关闭并替换 —— 否则会出现「改了地址还在连旧服务器」。
 */
export function getSession(): AnyListenSession {
  const { serverUrl, password } = requireCredentials()
  const key = `${serverUrl}\u0000${password}`
  if (session && sessionKey === key) return session

  if (session) session.close()
  sessionKey = key
  session = new AnyListenSession({
    serverUrl,
    password,
    // RN 提供全局 fetch 与 WebSocket；显式传入是为了让会话层不 import react-native
    WebSocketImpl: global.WebSocket as unknown as typeof WebSocket,
    fetchImpl: global.fetch as unknown as typeof fetch,
    onStateChange,
    onError,
  })
  void session.connect()
  return session
}

/** 主动断开（例如用户清空了服务器地址）。 */
export function resetSession(): void {
  session?.close()
  session = null
  sessionKey = ''
}

/** 在所有已建立连接的情形下确保有一个可用会话。 */
export async function ensureConnected(): Promise<AnyListenSession> {
  const s = getSession()
  if (s.getState() === 'connected') return s
  await s.connect()
  // 连接是异步建立的；这里不阻塞等待，由调用方的 call() 在未就绪时报错并触发重试。
  // 之所以不等：等待会把「连接慢」直接变成 UI 卡住，而 UI 需要立刻显示状态。
  //
  // ⚠️ 因此**不能**用本函数的结果当作「已连接」的判据 —— 它在 socket 真正
  // open 之前就 resolve 了。需要真正的可用性时用下面的 waitForConnected()。
  return s
}

/**
 * 等到会话**真的**连上为止（或判定不可能成功）。
 *
 * `connect()` 内部只是调 `openSocket()`，而 socket 的 `onopen` 是**异步**回调，
 * 所以 `connect()` resolve 时状态通常还是 `connecting`。用 `ensureConnected()`
 * 的结果当门禁会**提前放行**，随后的 RPC 照样失败。
 *
 * 这个区分很关键：播放门禁 `global.lx.apiInitPromise` 必须反映真实可用性，
 * 否则用户看到的是「已就绪」却放不出歌。
 *
 * @param timeoutMs 最长等待时间；超时抛错，避免门禁永远挂起。
 */
export async function waitForConnected(timeoutMs = 20_000): Promise<AnyListenSession> {
  const s = getSession()
  if (s.getState() === 'connected') return s

  await s.connect()

  const deadline = Date.now() + timeoutMs
  // 轮询而非监听：session 的状态回调是单播的（设置页已占用），
  // 这里再抢一个监听者会互相覆盖。轮询间隔取 100ms，代价可忽略。
  for (;;) {
    const state = s.getState()
    if (state === 'connected') return s
    // 'closed' 表示鉴权失败或未被重试的错误：再等也不会好
    if (state === 'closed') throw new Error('无法连接到 any-listen 服务器（会话已关闭）')
    if (Date.now() > deadline) throw new Error(`连接 any-listen 服务器超时（${timeoutMs / 1000} 秒）`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

// ---------------------------------------------------------------- 歌单

/** 取全部歌单（含 default / love / last_played 三个内置列表）。 */
export function getAllUserLists(): Promise<AnyListenMyAllList> {
  return getSession().call<AnyListenMyAllList>('getAllUserLists')
}

/** 取某个歌单的全部歌曲。返回**裸数组**，不是信封对象。 */
export function getListMusics(listId: string): Promise<AnyListenMusicList> {
  return getSession().call<AnyListenMusicList>('getListMusics', listId)
}

/**
 * 取歌单封面。
 *
 * ⚠️ 封面**不在** `list.meta` 里 —— 那里没有任何 pic/img/cover 字段。
 * 服务端是用「该歌单第一首歌的封面」算出来的
 * （`shared/app/modules/musicList/index.ts` 的 `getListsCover` →
 * `dbService.getListsFirstMusics` → `getMusicPic`），并带缓存。
 * 所以必须走这个 RPC，不能指望从歌单对象上读到。
 *
 * 返回虚拟地址（`al-ps-host:…`）或 null（歌单为空时），
 * 调用方需用 `resolveServerUrl` 解析。
 */
export function getListCover(listId: string): Promise<string | null | undefined> {
  return getSession().call<string | null | undefined>('getListCover', listId)
}

/** 歌单写操作。action 与 data 的形状见 docs/anylisten-api.md。 */
export function listAction(action: string, data: unknown): Promise<void> {
  return getSession().call<void>('listAction', { action, data })
}

// ---------------------------------------------------------------- 资源

/** 取播放地址。参数是**整个曲目对象**，不是 listId/musicId。 */
export function getMusicUrl(musicInfo: AnyListenMusicInfo): Promise<AnyListenMusicUrlInfo> {
  return getSession().call<AnyListenMusicUrlInfo>('getMusicUrl', { musicInfo })
}

/** 取封面。返回的 url 是虚拟地址或同源相对路径，必须解析后再用。 */
export function getMusicPic(musicInfo: AnyListenMusicInfo): Promise<AnyListenMusicPicInfo> {
  return getSession().call<AnyListenMusicPicInfo>('getMusicPic', { musicInfo })
}

/** 取歌词。返回的 info 里是带时间戳的 LRC 正文与逐字歌词。 */
export function getMusicLyric(musicInfo: AnyListenMusicInfo): Promise<AnyListenMusicLyricResult> {
  return getSession().call<AnyListenMusicLyricResult>('getMusicLyric', { musicInfo })
}

/**
 * 丢弃当前会话并用**最新凭据**重新连上。
 *
 * ## 为什么必须有这个函数
 *
 * 用户保存新的服务器地址 / 密码后，只调 `resetSession()` 是**不够**的：
 * 它只关掉 socket，没有任何东西会重建连接。而播放门禁
 * `global.lx.apiInitPromise[0]` 仍然是上个会话落定时的 `true` ——
 * 于是应用看起来「已就绪」，实际上连接已经死了。
 *
 * 表现就是：保存配置后进歌单页是空的，**手动点一下排序才显示**
 * （那一下触发了新的请求，而 `getSession()` 会顺手建连接）。
 * 根因在 `handleSave` 里只 reset 没有重连。
 *
 * 这里放在文件末尾，是因为它依赖 `waitForConnected` 与 `isConfigured`。
 *
 * @returns 连上后 resolve；连不上或未配置则 reject（调用方据此关闭门禁）
 */
export function restartSession(timeoutMs = 20_000): Promise<void> {
  resetSession()
  // 未配置服务器时不发起连接：那只会产生一串无意义的失败重连
  if (!isConfigured()) return Promise.reject(new Error('尚未配置 any-listen 服务器地址'))
  return waitForConnected(timeoutMs).then(() => undefined)
}
