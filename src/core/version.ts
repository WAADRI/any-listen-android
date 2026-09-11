import versionActions from '@/store/version/action'
import versionState, { type InitState } from '@/store/version/state'
import { saveIgnoreVersion } from '@/utils/data'
import { showVersionModal } from '@/navigation'
import { Navigation } from 'react-native-navigation'

/**
 * ## 本 fork 关闭了「检查更新」
 *
 * `utils/version.js` 里写死了**上游项目**的七个版本源
 * （lyswhut/lx-music-mobile 的 raw.githubusercontent / jsdelivr / gitee 等），
 * 而 `downloadNewVersion` 更是直接从
 * `github.com/lyswhut/lx-music-mobile/releases/...` 下载 apk。
 *
 * 对一个 fork 来说这有两个问题：
 *
 * 1. **会装错应用**：它拿到的是上游的版本号与上游的 apk，用户一点「更新」
 *    就把 lx-music-mobile 覆盖安装上来了；
 * 2. **无谓的外发**：每次启动都会去访问上游仓库，而这个包并不由那里分发。
 *
 * 因此不再发起检查。状态直接置为「已是最新」，让版本界面不显示错误。
 * 如果将来要给这个 fork 做更新，应当改成自己的发布地址，而不是恢复这些常量。
 */
export const showModal = () => {
  if (versionState.showModal) return
  versionActions.setVisibleModal(true)
  showVersionModal()
}

export const hideModal = (componentId: string) => {
  if (!versionState.showModal) return
  versionActions.setVisibleModal(false)
  void Navigation.dismissOverlay(componentId)
}

export const checkUpdate = async() => {
  versionActions.setVersionInfo({
    status: 'idle',
    isLatest: true,
    isUnknown: false,
    // 用当前版本号作为占位，界面显示「已是最新」，不再是「未知」或报错
    newVersion: {
      version: versionState.versionInfo.version,
      desc: '',
      history: [],
    },
  })
}

export const downloadUpdate = () => {
  // 不再下载：上游地址会装错应用，见 checkUpdate 的说明。
  versionActions.setVersionInfo({ status: 'error' })
}


export const setIgnoreVersion = (version: InitState['ignoreVersion']) => {
  versionActions.setIgnoreVersion(version)
  saveIgnoreVersion(version)
}
