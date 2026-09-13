import {
  play as lrcPlay,
  setLyric as lrcSetLyric,
  pause as lrcPause,
  setPlaybackRate as lrcSetPlaybackRate,
  toggleTranslation as lrcToggleTranslation,
  toggleRoma as lrcToggleRoma,
  init as lrcInit,
} from '@/plugins/lyric'
import {
  playDesktopLyric,
  setDesktopLyric,
  pauseDesktopLyric,
  setDesktopLyricPlaybackRate,
  toggleDesktopLyricTranslation,
  toggleDesktopLyricRoma,
} from '@/core/desktopLyric'
import { getPosition } from '@/plugins/player'
import playerState from '@/store/player/state'
import settingState from '@/store/setting/state'
import { updateNowPlayingTitles } from '@/plugins/player/utils'

/**
 * init lyric
 */
export const init = async() => {
  return lrcInit()
}

/**
 * set lyric
 * @param lyric lyric str
 * @param translation lyric translation
 * @param romalrc lyric roma
 * @param awlrc word-by-word lyric (any-listen 的 awlyric)
 */
const handleSetLyric = async(lyric: string, translation = '', romalrc = '', awlrc = '') => {
  lrcSetLyric(lyric, translation, romalrc, awlrc)
  await setDesktopLyric(lyric, translation, romalrc, awlrc)
  if (settingState.setting['player.isShowBluetoothFullLyric']) {
    void updateNowPlayingTitles({
      lyric,
    })
  }
}

/**
 * play lyric
 * @param time play time
 */
export const handlePlay = (time: number) => {
  lrcPlay(time)
  void playDesktopLyric(time)
}

/**
 * pause lyric
 */
export const pause = () => {
  lrcPause()
  void pauseDesktopLyric()
}

/**
 * stop lyric
 */
export const stop = () => {
  void handleSetLyric('')
}

/**
 * 拖动进度条 / 跳到某一行：把歌词与桌面歌词**重新对齐**到新位置。
 *
 * 上游只把位置写进播放器就算完，歌词插件与桌面歌词窗口的时钟都还停在旧位置——
 * 逐字扫光因此不会跟着走（往前拖不会补上、往回拖也不会退掉，真机反馈）。
 * 对齐之后如果本来是暂停状态，再把两边的时钟冻住（`play()` 会把它们置成播放中）。
 */
export const seek = (time: number) => {
  handlePlay(time * 1000)
  if (!playerState.isPlay) {
    lrcPause()
    void pauseDesktopLyric()
  }
}

/**
 * set playback rate
 * @param playbackRate playback rate
 */
export const setPlaybackRate = async(playbackRate: number) => {
  lrcSetPlaybackRate(playbackRate)
  await setDesktopLyricPlaybackRate(playbackRate)
  if (playerState.isPlay) {
    setTimeout(() => {
      void getPosition().then((position) => {
        handlePlay(position * 1000)
      })
    })
  }
}

/**
 * toggle show translation
 * @param isShowTranslation is show translation
 */
export const toggleTranslation = async(isShowTranslation: boolean) => {
  lrcToggleTranslation(isShowTranslation)
  await toggleDesktopLyricTranslation(isShowTranslation)
  if (playerState.isPlay) play()
}

/**
 * toggle show roma lyric
 * @param isShowLyricRoma is show roma lyric
 */
export const toggleRoma = async(isShowLyricRoma: boolean) => {
  lrcToggleRoma(isShowLyricRoma)
  await toggleDesktopLyricRoma(isShowLyricRoma)
  if (playerState.isPlay) play()
}

export const play = () => {
  void getPosition().then((position) => {
    handlePlay(position * 1000)
  })
}


export const setLyric = async() => {
  if (!playerState.musicInfo.id) return
  if (playerState.musicInfo.lrc) {
    let tlrc = ''
    let rlrc = ''
    if (playerState.musicInfo.tlrc) tlrc = playerState.musicInfo.tlrc
    if (playerState.musicInfo.rlrc) rlrc = playerState.musicInfo.rlrc
    // lxlrc 就是服务端的逐字歌词（any-listen 的 awlyric），由适配层映射过来
    await handleSetLyric(playerState.musicInfo.lrc, tlrc, rlrc, playerState.musicInfo.lxlrc ?? '')
  }

  if (playerState.isPlay) play()
}
