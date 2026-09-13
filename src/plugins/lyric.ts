import { useEffect, useState } from 'react'
import Lyric, { type Lines } from 'lrc-file-parser'
import { parseAwlrc, type Awlrc } from '@/utils/awlrc'
// import { getStore, subscribe } from '@/store'
export type Line = Lines[number]
type PlayHook = (line: number, text: string) => void
type SetLyricHook = (lines: Lines) => void
type SetAwlrcHook = (awlrc: Awlrc) => void

export const emptyAwlrc: Awlrc = { lines: [], byTime: new Map(), hasWordTiming: false }

/**
 * 歌词偏移（毫秒），交给 `lrc-file-parser`：它让**行**比原始时间戳提前这么多切换。
 *
 * 逐字扫光必须加同一个偏移（见 `utils/hooks/useWordLyricProgress.ts` 的
 * `elapsedInLine`），否则扫光会比行切换慢——真机上表现为「播放页的扫光比桌面歌词慢一个字」。
 * 桌面歌词窗口在 Java 侧有自己的偏移（`LyricPlayer.offset = 150`），两边各自保证
 * 「行切换与扫光用同一个偏移」即可，剩下的 50ms 差看不出来。
 */
export const lyricOffset = 100

const lrcTools = {
  isInited: false,
  lrc: null as Lyric | null,
  currentLineData: { line: 0, text: '' },
  currentLines: [] as Lines,
  /** 逐字歌词（服务端的 awlyric），与 currentLines 同源、独立解析 */
  awlrc: emptyAwlrc as Awlrc,
  playHooks: [] as PlayHook[],
  setLyricHooks: [] as SetLyricHook[],
  awlrcHooks: [] as SetAwlrcHook[],
  isPlay: false,
  isShowTranslation: false,
  isShowRoma: false,
  lyricText: '',
  translationText: '' as string | null | undefined,
  romaText: '' as string | null | undefined,
  init() {
    if (this.isInited) return
    this.isInited = true
    this.lrc = new Lyric({
      onPlay: this.onPlay.bind(this),
      onSetLyric: this.onSetLyric.bind(this),
      offset: lyricOffset, // offset time(ms), default is 150 ms
    })
  },
  onPlay(line: number, text: string) {
    this.currentLineData.line = line
    // console.log(line)
    this.currentLineData.text = text
    for (const hook of this.playHooks) hook(line, text)
  },
  onSetLyric(lines: Lines) {
    this.currentLines = lines
    this.currentLineData.line = 0
    this.currentLineData.text = ''
    for (const hook of this.playHooks) hook(-1, '')
    for (const hook of this.setLyricHooks) hook(lines)
  },
  addPlayHook(hook: PlayHook) {
    this.playHooks.push(hook)
    hook(this.currentLineData.line, this.currentLineData.text)
  },
  removePlayHook(hook: PlayHook) {
    this.playHooks.splice(this.playHooks.indexOf(hook), 1)
  },
  addSetLyricHook(hook: SetLyricHook) {
    this.setLyricHooks.push(hook)
    hook(this.currentLines)
  },
  removeSetLyricHook(hook: SetLyricHook) {
    this.setLyricHooks.splice(this.setLyricHooks.indexOf(hook), 1)
  },
  notifyAwlrc() {
    for (const hook of this.awlrcHooks) hook(this.awlrc)
  },
  addAwlrcHook(hook: SetAwlrcHook) {
    this.awlrcHooks.push(hook)
    hook(this.awlrc)
  },
  removeAwlrcHook(hook: SetAwlrcHook) {
    this.awlrcHooks.splice(this.awlrcHooks.indexOf(hook), 1)
  },
  setLyric() {
    const extendedLyrics = [] as string[]
    if (this.isShowTranslation && this.translationText) extendedLyrics.push(this.translationText)
    if (this.isShowRoma && this.romaText) extendedLyrics.push(this.romaText)
    this.lrc!.setLyric(this.lyricText, extendedLyrics)
  },
}


export const init = async() => {
  lrcTools.init()
}

export const setLyric = (lyric: string, translation?: string, romalrc?: string, awlrc?: string) => {
  lrcTools.isPlay = false
  lrcTools.lyricText = lyric
  lrcTools.translationText = translation
  lrcTools.romaText = romalrc
  // 逐字歌词与普通歌词同源，一起换掉；没有逐字信息时解析结果为空，界面自然退回逐行
  lrcTools.awlrc = parseAwlrc(awlrc)
  lrcTools.notifyAwlrc()
  lrcTools.setLyric()
}
export const setPlaybackRate = (playbackRate: number) => {
  lrcTools.lrc!.setPlaybackRate(playbackRate)
}
export const toggleTranslation = (isShow: boolean) => {
  lrcTools.isShowTranslation = isShow
  if (!lrcTools.lyricText) return
  lrcTools.setLyric()
}
export const toggleRoma = (isShow: boolean) => {
  lrcTools.isShowRoma = isShow
  if (!lrcTools.lyricText) return
  lrcTools.setLyric()
}
export const play = (time: number) => {
  // console.log(time)
  lrcTools.isPlay = true
  lrcTools.lrc!.play(time)
}
export const pause = () => {
  // console.log('pause')
  lrcTools.isPlay = false
  lrcTools.lrc!.pause()
}

// on lyric play hook
export const useLrcPlay = (autoUpdate = true) => {
  const [lrcInfo, setLrcInfo] = useState(lrcTools.currentLineData)
  useEffect(() => {
    if (!autoUpdate) return
    const setLrcCallback: SetLyricHook = () => {
      setLrcInfo({ line: 0, text: '' })
    }
    const playCallback: PlayHook = (line, text) => {
      setLrcInfo({ line, text })
    }
    lrcTools.addSetLyricHook(setLrcCallback)
    lrcTools.addPlayHook(playCallback)
    setLrcInfo(lrcTools.currentLineData)
    return () => {
      lrcTools.removeSetLyricHook(setLrcCallback)
      lrcTools.removePlayHook(playCallback)
    }
  }, [autoUpdate])

  return lrcInfo
}

// on lyric set hook
export const useLrcSet = () => {
  const [lines, setLines] = useState<Lines>(lrcTools.currentLines)
  useEffect(() => {
    const callback = (lines: Lines) => {
      setLines(lines)
    }
    lrcTools.addSetLyricHook(callback)
    return () => { lrcTools.removeSetLyricHook(callback) }
  }, [])

  return lines
}

// on word-by-word lyric set hook
export const useAwlrc = () => {
  const [awlrc, setAwlrc] = useState<Awlrc>(lrcTools.awlrc)
  useEffect(() => {
    const callback = (awlrc: Awlrc) => {
      setAwlrc(awlrc)
    }
    lrcTools.addAwlrcHook(callback)
    return () => { lrcTools.removeAwlrcHook(callback) }
  }, [])

  return awlrc
}

