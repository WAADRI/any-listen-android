import { useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { getPosition } from '@/plugins/player'
import { useIsPlay } from '@/store/player/hook'
import playerState from '@/store/player/state'
import { playedCount, type AwlrcLine } from '@/utils/awlrc'
import { AwlrcClock, lineEndAt, nextBoundaryAt } from '@/utils/awlrcPlayer'
import { lyricOffset } from '@/plugins/lyric'

/**
 * 逐字歌词的全局时钟。
 *
 * 与 lx-music-desktop 一致：**播放位置只在 play / pause / seek / 换行时取一次**，
 * 其余时间靠这个时钟自己走。上一版每 100ms 去问一次播放位置，既让段的切换被量化到
 * 100ms 网格（看着「生硬」），又每 100ms 触发一次 React 重渲染（Android 上改一个
 * Text span 的颜色会重建整段文字的 Spannable，于是「卡顿」）。
 *
 * 需要自己驱动动画的消费方（`WordLyricLine` 的扫光）直接读这个时钟，
 * 并把 `resyncVersion` 放进 effect 依赖里，重新锚定时重画。
 */
export const wordLyricClock = new AwlrcClock()

/**
 * 相对本行起始已经唱了多久（毫秒）。
 *
 * **必须加上行切换用的那个歌词偏移**（`plugins/lyric.ts` 的 `lyricOffset`）：
 * `lrc-file-parser` 用 `offset` 让「行」提前切换，而逐字段的时间戳是原始时间；
 * 少加这 100ms，扫光就比行切换（以及桌面歌词窗口）慢一截
 * ——真机反馈正是「播放页的扫光比桌面歌词慢一个字」。
 */
export const elapsedInLine = (lineTimeMs: number, now = Date.now()) =>
  wordLyricClock.positionAt(now) + lyricOffset - lineTimeMs

export interface WordLyricProgress {
  /** 已唱完的段数（逐个换色的兜底渲染、底栏用） */
  played: number
  /** 整行是否已经**唱完**（最后一段也扫完了）——翻译/罗马音要等这时候才淡入 */
  isFinished: boolean
  /** 每次重新锚定自增；自己驱动动画的消费方用它当 effect 依赖 */
  resyncVersion: number
}

const VERIFY_INTERVAL = 1000
const VERIFY_TOLERANCE = 300

const readPosition = async(): Promise<number | null> => {
  try {
    const position = await getPosition()
    return typeof position === 'number' && position >= 0 ? position * 1000 : null
  } catch {
    return null
  }
}

/**
 * 逐字歌词的进度。
 *
 * @param line 当前行在逐字歌词里的对应行（没有逐字信息时传 undefined）
 */
export const useWordLyricProgress = (line: AwlrcLine | undefined): WordLyricProgress => {
  const isPlay = useIsPlay()
  const [played, setPlayed] = useState(0)
  const [isFinished, setIsFinished] = useState(false)
  const [resyncVersion, setResyncVersion] = useState(0)

  // 重新锚定：换行、播放/暂停切换、拖动进度条、回到前台，都用本机播放位置校准一次
  // 换行瞬间必须先把时钟锚到「这一行的起点」，否则在异步读到播放位置之前，扫光会拿上一行的
  // 锚点去算：表现就是新行「先飞快扫一下、再从头开始扫」（真机反馈）。等真实位置读回来
  // (几毫秒)会再校正一次，看不出来。
  const prevLineRef = useRef<AwlrcLine | undefined>(undefined)

  // ⚠️ 换行的锚定必须在**渲染期间**同步做：放到 effect 里的话，新行的第一帧仍会用上一行的
  // 锚点算，于是先飞快扫一下、再归零从头扫（真机反馈的「抽搐」）。这里是幂等的赋值。
  if (prevLineRef.current !== line) {
    prevLineRef.current = line
    if (line) wordLyricClock.setPlay(false, Date.now(), line.timeMs - lyricOffset)
  }

  useEffect(() => {
    let isUnmounted = false
    const resync = () => {
      void readPosition().then((position) => {
        if (isUnmounted) return
        // 读不到位置（播放器还没就绪）也要恢复走表，否则逐字歌词会一直冻住
        if (position == null) wordLyricClock.setPlay(isPlay, Date.now())
        else wordLyricClock.setPlay(isPlay, Date.now(), position)
        setResyncVersion(version => version + 1)
      })
    }
    // 暂停时先停表，位置不再前进；恢复播放要等读到真实位置再起表
    wordLyricClock.setPlay(false, Date.now())
    resync()

    const handleSetProgress = (time?: number) => {
      // 拖动进度条时**不要**去读播放位置：seek 是异步的，读回来常常还是旧位置，
      // 扫光就会停在拖之前那一格（真机反馈：往前拖不补、往回拖不退）。
      // 事件里带的才是目标位置（单位是秒）。
      if (typeof time === 'number' && time >= 0) {
        wordLyricClock.setPlay(isPlay, Date.now(), time * 1000)
        setResyncVersion(version => version + 1)
        return
      }
      resync()
    }
    // 拖进度条、跳到某一行、恢复播放进度都会发这个事件
    global.app_event.on('setProgress', handleSetProgress)

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') resync()
    })

    return () => {
      isUnmounted = true
      global.app_event.off('setProgress', handleSetProgress)
      subscription.remove()
    }
  }, [line, isPlay])

  // 只在「段开始」的时刻醒一次，中间靠动画自己走完（与桌面版的 timeoutTools 一致）
  useEffect(() => {
    const segments = line?.segments
    const lineTimeMs = line?.timeMs
    setIsFinished(false)
    if (!segments?.length || lineTimeMs == null) {
      setPlayed(0)
      return
    }

    let isUnmounted = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const step = () => {
      if (isUnmounted) return
      const elapsed = elapsedInLine(lineTimeMs)
      setPlayed(playedCount(segments, elapsed))

      const next = nextBoundaryAt(segments, elapsed)
      if (next == null) {
        // 已经没有下一段的起点了：再等「这一行唱完」那一刻醒一次，通知外面翻译/罗马音可以淡入
        const end = lineEndAt(segments)
        if (elapsed >= end) {
          setIsFinished(true)
          return
        }
        if (!wordLyricClock.isPlay || AppState.currentState === 'background') return
        timer = setTimeout(step, Math.max(16, (end - elapsed) / wordLyricClock.rate))
        return
      }
      if (!wordLyricClock.isPlay) return
      // 后台时这一层没人看，别再唤醒自己；回到前台会重新锚定并重跑本 effect
      if (AppState.currentState === 'background') return
      const delay = (next - elapsed) / wordLyricClock.rate
      timer = setTimeout(step, Math.max(16, delay))
    }
    step()

    return () => {
      isUnmounted = true
      if (timer) clearTimeout(timer)
    }
  }, [line, resyncVersion, isPlay])

  // 兜底校准：每秒用播放器真实位置核对一次本地时钟，偏差超过 300ms 就重新锚定。
  // 上面的 setProgress / play / pause 都是「别人通知我」，只要有一条路径没通知到
  // （拖动进度条就是这么报上来的），扫光就会一直停在旧位置。注意分工：**动画仍由段边界
  // 定时器驱动**，这里只做一次数值相减，没偏差就不重渲染。
  useEffect(() => {
    const lineTimeMs = line?.timeMs
    if (!line?.segments.length || lineTimeMs == null) return
    const timer = setInterval(() => {
      if (!playerState.isPlay || AppState.currentState === 'background') return
      void readPosition().then((position) => {
        if (position == null) return
        if (Math.abs(wordLyricClock.positionAt(Date.now()) - position) < VERIFY_TOLERANCE) return
        wordLyricClock.setPlay(true, Date.now(), position)
        setResyncVersion(version => version + 1)
      })
    }, VERIFY_INTERVAL)
    return () => { clearInterval(timer) }
  }, [line])

  return { played, isFinished, resyncVersion }
}

export default useWordLyricProgress
