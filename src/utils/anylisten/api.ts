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
  return s
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
