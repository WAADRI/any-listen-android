import { useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { getPosition } from '@/plugins/player'
import { useIsPlay } from '@/store/player/hook'
import { log } from '@/utils/log'
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
  const prevAnchorRef = useRef<{ line?: AwlrcLine | undefined, isPlay?: boolean }>({})

  // 外部锚定（core/lyric.ts 的 handlePlay）也要能触发扫光重画：
  // 恢复播放时它锚定的读数才是 parser 与时钟共同的时间基准
  useEffect(() => {
    const off = wordLyricClock.onAnchor(() => { setResyncVersion(version => version + 1) })
    return () => { off() }
  }, [])

  // 重新锚定：换行、播放/暂停切换、拖动进度条、回到前台，都用本机播放位置校准一次
  useEffect(() => {
    let isUnmounted = false
    const lineTimeMs = line?.timeMs
    // 诊断日志：真机「首字/前几个字快扫一下再从头扫」的问题模拟器上不出现，
    // 需要真机日志定位。只记录重锚来源与位置偏差（有逐字行时才打，避免刷屏）。
    const source = prevAnchorRef.current.line !== line
      ? '换行'
      : prevAnchorRef.current.isPlay !== isPlay ? (isPlay ? '恢复播放' : '暂停') : 'effect重跑'
    prevAnchorRef.current = { line, isPlay }
    const resync = (via: string) => {
      // 外部（core/lyric.ts 的 handlePlay）刚用**同一次读数**锚过（parser 与扫光
      // 时钟同锚）：让位，不再自己读一次——两次读取的时刻差会被固化成两条
      // 时钟的恒定偏差，真机上就是恢复播放后每次换行「首字快扫一下再从头扫」。
      // 只 bump resyncVersion 让扫光按新锚点重画。
      if (isPlay && Date.now() - wordLyricClock.anchorAt < 300) {
        if (lineTimeMs != null) log.info(`[lyric] 重锚(${via}/${source}) 行=${lineTimeMs}ms 让位外部锚定`)
        setResyncVersion(version => version + 1)
        return
      }
      const before = wordLyricClock.isPlay ? Math.round(wordLyricClock.positionAt(Date.now())) : null
      void readPosition().then((position) => {
        if (isUnmounted) return
        // 读不到位置（播放器还没就绪）也要恢复走表，否则逐字歌词会一直冻住
        if (position == null) wordLyricClock.setPlay(isPlay, Date.now())
        else wordLyricClock.setPlay(isPlay, Date.now(), position)
        if (lineTimeMs != null) {
          log.info(`[lyric] 重锚(${via}/${source}) 行=${lineTimeMs}ms 位置=${position ?? '读取失败'}ms` +
            (before != null && position != null ? ` 重锚前时钟=${before}ms 偏差=${position - before}ms` : ''))
        }
        setResyncVersion(version => version + 1)
      })
    }
    // 只有「暂停」才先停表，位置冻结在停表那一刻。**播放中的换行不能停表**：
    // 停表 → 异步读位置的空窗里，新挂载的扫光会先按「冻结位置」摆一下，读到
    // 真实位置重锚后又摆回去 —— 真机上就是「换行后前几个字快扫一下再从头扫」
    // （暂停恢复后的首次换行，恢复锚点带上的偏差会把这次瞬切放大到整字可见；
    // 拖进度/切歌没有这个叠加，所以看不出问题）。播放中保持时钟在走、读到
    // 位置再原子重锚，空窗里只剩读位置那点毫秒级漂移。
    if (!isPlay) wordLyricClock.setPlay(false, Date.now())
    resync('effect')

    const handleSetProgress = () => {
      resync('setProgress事件')
    }
    // 拖进度条、跳到某一行、恢复播放进度都会发这个事件
    global.app_event.on('setProgress', handleSetProgress)

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') resync('回前台')
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
