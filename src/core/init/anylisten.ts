/**
 * 把 lx 的设置系统接到 any-listen 各模块的注入口上。
 *
 * 各模块（`api` / `convert` / `musicSdk/anylisten`）刻意不直接 import 设置 store，
 * 那样会把整棵 app 依赖树拖进去，也就无法在 Node 下单测。
 * 这个文件是**唯一**知道「设置存在哪里」的地方。
 *
 * 初始化顺序很重要：必须在 `setApiSource()` **之前**调用，
 * 因为 `setApiSource` 会立刻读取 `musicSdk.supportQuality` 并触发源的 `init()`。
 */
import settingState from '@/store/setting/state'
import { setupAnyListen } from '@/utils/anylisten/api'
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
}): void {
  const getServerUrl = readServerUrl
  const getPassword = readPassword

  setupAnyListen({
    getCredentials: () => ({ serverUrl: getServerUrl(), password: getPassword() }),
    onStateChange: options?.onStateChange,
    onError: options?.onError,
  })
  setupConvert({ getServerUrl })
  setupSource({ getServerUrl })
}
