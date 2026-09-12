/**
 * 把 lx 的设置系统接到 any-listen 各模块的注入口上。
 *
 * 各模块（`api` / `convert` / `musicSdk/anylisten`）刻意不直接 import 设置 store，
 * 那样会把整棵 app 依赖树拖进去，也就无法在 Node 下单测。
 * 这个文件是**唯一**知道「设置存在哪里」的地方。
 *
 * 初始化顺序很重要：必须在 `setApiSource()` **之前**调用，
 * 因为 `setApiSource` 会读取 `musicSdk.supportQuality`，
 * 并把播放门禁 `global.lx.apiInitPromise` 接到本函数返回的 promise 上。
 *
 * ## 返回值就是播放门禁
 *
 * `handleGetOnlineMusicUrl` 等方法开头都是
 * `if (!await global.lx.apiInitPromise[0]) throw new Error('source init failed')`。
 * 因此返回的 promise **必须真实反映能否取到数据**：
 * 未配置服务器时立刻拒绝，配置了就等连接建立。否则用户看到的会是
 * 「source init failed」这种与真实原因无关的提示。
 */
import settingState from '@/store/setting/state'
import { setupAnyListen, waitForConnected, restartSession, isConfigured } from '@/utils/anylisten/api'
import { setupConvert } from '@/utils/anylisten/convert'
import { setupSource } from '@/utils/musicSdk/anylisten'
import { normalizeServerUrl, type ConnState } from '@/utils/anylisten/client'
import { settleApiGate } from '@/core/apiSource'
import { log } from '@/utils/log'

/** 读当前配置。任何异常都退化成「未配置」，避免初始化整体失败。 */
function readServerUrl(): string {
  try {
    return normalizeServerUrl(settingState.setting['anylisten.serverUrl'] ?? '')
  } catch {
    return ''
  }
}

function readPassword(): string {
  try {
    return settingState.setting['anylisten.password'] ?? ''
  } catch {
    return ''
  }
}

export default function initAnyListen(options?: {
  onStateChange?: (state: ConnState, detail?: string) => void
  onError?: (message: string) => void
}): Promise<void> {
  const getServerUrl = readServerUrl
  const getPassword = readPassword

  setupAnyListen({
    getCredentials: () => ({ serverUrl: getServerUrl(), password: getPassword() }),
    // 默认把连接状态与错误写进日志。
    //
    // 为什么重要：连接问题的表现是**静默**的 —— 界面上只是「没有歌」。
    // 而本 fork 的包由 CI 产出、装到手机上排查，logcat 基本是唯一通道；
    // 不接这两个回调的话，服务端连不上时日志里**一个字都没有**。
    // `log` 最终会 console.log（见 utils/log.ts 的 writeLog），所以能进 logcat。
    onStateChange: options?.onStateChange ?? ((state: ConnState, detail?: string) => {
      log.info(`[anylisten] 连接状态 ${state}${detail ? `：${detail}` : ''}`)
    }),
    onError: options?.onError ?? ((message: string) => {
      log.error(`[anylisten] ${message}`)
    }),
  })
  setupConvert({ getServerUrl })
  setupSource({ getServerUrl })

  // 未配置服务器时不要发起连接：那只会产生一串无意义的失败重连，
  // 而用户此刻需要的是去设置页填地址。直接拒绝，让门禁保持关闭。
  if (!isConfigured()) {
    const message = '尚未配置 any-listen 服务器地址，请在「设置 → 基础设置」中填写'
    log.warn(`[anylisten] ${message}`)
    return Promise.reject(new Error(message))
  }

  // 只记地址，**绝不记密码**：日志会落到手机上的文件，也可能被贴出来排查。
  log.info(`[anylisten] 服务器地址 ${getServerUrl()}`)

  // 必须等**真的**连上：connect() 在 socket open 之前就 resolve 了，
  // 用它当门禁会提前放行，随后播放照样失败。见 waitForConnected 的说明。
  return waitForConnected().then(
    () => { log.info('[anylisten] 已连接，播放门禁已打开') },
    (err: unknown) => {
      // 这里必须记：门禁没打开的话所有播放都会失败，而失败提示是
      // 「source init failed」这种与真实原因无关的文本。
      log.error(`[anylisten] 连接失败，播放不可用：${err instanceof Error ? err.message : String(err)}`)
      throw err
    },
  )
}

/**
 * 用户改了服务器地址 / 密码后调用。
 *
 * ## 为什么不能只调 `resetSession()`
 *
 * 只关掉旧 socket 的话，**没有任何东西会重建连接**，而播放门禁仍是
 * 上个会话落定时的值。表现就是：保存配置后进歌单页是空的，
 * 手动点一下排序才显示（那一下触发新请求，`getSession()` 顺手建了连接）。
 *
 * ## 为什么重连成功后还要重新落定门禁
 *
 * 门禁曾经只在启动时落定一次。如果启动时**没有配置服务器**（用户清空了数据
 * 就是这种情况），它会停在 `false`，之后即使重连成功也**再也不会变回 true** ——
 * 表现为「连接正常、歌单能加载、歌词能取到，但每首歌都报 `source init failed`」。
 * 这个组合非常有迷惑性，因为它看起来完全不像连接问题。
 *
 * 所以这里在连上之后必须重新装填门禁。失败时同样要落定，避免播放永远挂在
 * 「等待初始化」上。
 */
export function restartAnyListen(): Promise<void> {
  log.info('[anylisten] 配置已更改，重新建立连接')
  // 把门禁**先挂到这次的连接尝试上**，再开始连。
  // 不能用启动时那个 promise：它在「启动时未配置」的情况下已经失败，
  // 拿它落定会让门禁永远是关闭的（就是 source init failed 的成因）。
  const attempt = restartSession()
  settleApiGate(attempt)
  return attempt.then(
    () => {
      log.info('[anylisten] 已重连，播放门禁已重新打开')
    },
    (err: unknown) => {
      log.error(`[anylisten] 重新连接失败：${err instanceof Error ? err.message : String(err)}`)
      throw err
    },
  )
}

