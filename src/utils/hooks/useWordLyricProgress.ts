import { useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { getPosition } from '@/plugins/player'
import { useIsPlay } from '@/store/player/hook'
import { playedCount, type AwlrcLine } from '@/utils/awlrc'
import { AwlrcClock, nextBoundaryAt } from '@/utils/awlrcPlayer'

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

export interface WordLyricProgress {
  /** 已唱完的段数（逐个换色的兜底渲染、底栏用） */
  played: number
  /** 每次重新锚定自增；自己驱动动画的消费方用它当 effect 依赖 */
  resyncVersion: number
}

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
  const [resyncVersion, setResyncVersion] = useState(0)

  // 重新锚定：换行、播放/暂停切换、拖动进度条、回到前台，都用本机播放位置校准一次
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

    const handleSetProgress = () => {
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
    if (!segments?.length || lineTimeMs == null) {
      setPlayed(0)
      return
    }

    let isUnmounted = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const step = () => {
      if (isUnmounted) return
      const elapsed = wordLyricClock.positionAt(Date.now()) - lineTimeMs
      setPlayed(playedCount(segments, elapsed))

      const next = nextBoundaryAt(segments, elapsed)
      if (next == null || !wordLyricClock.isPlay) return
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

  return { played, resyncVersion }
}

export default useWordLyricProgress
