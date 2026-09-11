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
import { setupAnyListen, ensureConnected, isConfigured } from '@/utils/anylisten/api'
import { setupConvert } from '@/utils/anylisten/convert'
import { setupSource } from '@/utils/musicSdk/anylisten'
import { normalizeServerUrl, type ConnState } from '@/utils/anylisten/client'

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
    onStateChange: options?.onStateChange,
    onError: options?.onError,
  })
  setupConvert({ getServerUrl })
  setupSource({ getServerUrl })

  // 未配置服务器时不要发起连接：那只会产生一串无意义的失败重连，
  // 而用户此刻需要的是去设置页填地址。直接拒绝，让门禁保持关闭。
  if (!isConfigured()) {
    return Promise.reject(new Error('尚未配置 any-listen 服务器地址，请在「设置 → 基础设置」中填写'))
  }

  return ensureConnected().then(() => undefined)
}

