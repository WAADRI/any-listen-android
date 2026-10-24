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
import { wordLyricClock } from '@/utils/hooks/useWordLyricProgress'
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
  // 用**同一次读数**锚定逐字扫光时钟。歌词 parser 与扫光时钟是两条独立时钟，
  // 各自读一次播放位置的话，两次异步读取的时刻差（真机恢复播放时实测约
  // 140ms）会被固化成两条时钟的恒定偏差——之后每次换行 parser 都偏差切行，
  // 新行挂载时第一段已经「唱过」几十毫秒，兜底渲染把第一个字闪成已唱色、
  // 扫光又从 0 追（真机「首字快扫一下再从头扫」）。这里锚定后，
  // useWordLyricProgress 的 resync 会按 anchorAt 让位，不再引入第二次读取差。
  wordLyricClock.setPlay(true, Date.now(), time)
}

/**
 * pause lyric
 */
export const pause = () => {
  lrcPause()
  void pauseDesktopLyric()
  wordLyricClock.setPlay(false, Date.now())
}

/**
 * stop lyric
 */
export const stop = () => {
  void handleSetLyric('')
}

/**
 * set playback rate
 * @param playbackRate playback rate
 */
export const setPlaybackRate = async(playbackRate: number) => {
  lrcSetPlaybackRate(playbackRate)
  // 扫光时钟的倍速也要同步，否则扫光动画的时长（段剩余时长 / rate）按旧倍速算
  wordLyricClock.setRate(playbackRate, Date.now())
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
  // native 播放器 resume 有约 130~140ms 的起跑延迟（JS 侧 play() 到 ExoPlayer
  // 真正出声），期间读到的位置都是「还没起跑」的——把 parser 与扫光时钟锚在
  // 这一刻，之后每次换行都会带着这个延迟滞后切行（真机日志：恢复后换行
  // 重锚位置超前行首 ~40ms = 100ms 设计提前量被起跑延迟吃掉）。稍后 native
  // 已真正起跑时再统一锚定一次，两条时钟一起对齐到真实位置。
  setTimeout(() => {
    if (!playerState.isPlay) return
    void getPosition().then((position) => {
      if (!playerState.isPlay) return
      handlePlay(position * 1000)
    })
  }, 250)
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
