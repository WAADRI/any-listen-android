import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Animated, AppState, Easing, StyleSheet, View, type ColorValue, type LayoutChangeEvent, type TextStyle } from 'react-native'
import Text from '@/components/common/Text'
import { type AwlrcLine, type AwlrcSegment } from '@/utils/awlrc'
import { nextBoundaryAt, sweepXAt } from '@/utils/awlrcPlayer'
import { useWordLyricProgress, wordLyricClock } from '@/utils/hooks/useWordLyricProgress'

/**
 * 播放页当前行的逐字歌词（卡拉OK 扫光）。
 *
 * ## 与 lx-music-desktop 的关系
 *
 * 桌面版是 DOM + CSS：每段一个 `span`，用 WAAPI 把 `background-size` 从
 * `0 100%` 线性动画到 `100% 100%`，配合 `background-clip: text` 得到「字里被涂色的
 * 宽度随时间线性增长」。动画跑在合成器上，JS 只在每段开始时醒一次，所以又顺又不掉帧。
 *
 * RN 没有 `background-clip: text`，也没有能在原生侧插值的裁剪宽度，所以这里换成等价画法：
 * **同一行画两遍**——下面是未唱色，上面是已唱色，上层放在一个 `overflow: hidden`
 * 的盒子里，盒子宽度随时间线性增长，于是「已唱色从左往右扫出来」。两层文字位置完全
 * 相同、都不动，边界是硬切，和桌面版 `background-size` 的硬边界一致。
 *
 * 时间轴照搬桌面版：播放位置只在 play / pause / seek / 换行时读一次，之后靠
 * `wordLyricClock` 自己走，每段开始时开一次线性动画、时长就是这一段自己的时长
 * （见 `utils/awlrcPlayer.ts`）。**动画期间不触发任何 React 重渲染。**
 *
 * ## 什么时候退回「逐段换色」
 *
 * 下面几种情况没法用两层扫光，退回上一版的逐段换色（仍由新的时间轴驱动，不再 100ms 轮询）：
 * - 一行放不下（会折行）：整行是一个矩形，扫光会把第二行的左边也一起点亮；
 * - 段宽度/文字高度还没量到，或两层的排版与整行文字对不上（防御性检查）。
 */

/** 一行的两套文字完全一样，量其中一套的位置即可 */
type SegmentLayout = (index: number, x: number, width: number) => void

const TextRow = memo(({ segments, size, lineHeight, color, onSegmentLayout }: {
  segments: readonly AwlrcSegment[]
  size: number
  lineHeight: number
  color: ColorValue
  onSegmentLayout?: SegmentLayout
}) => (
  <>
    {segments.map((segment, index) => (
      <Text
        key={index}
        size={size}
        color={color}
        numberOfLines={1}
        style={{ lineHeight }}
        onLayout={onSegmentLayout
          ? (event) => { onSegmentLayout(index, event.nativeEvent.layout.x, event.nativeEvent.layout.width) }
          : undefined}
      >{segment.text}</Text>
    ))}
  </>
))

interface Props {
  line: AwlrcLine
  size: number
  lineHeight: number
  textAlign: TextStyle['textAlign']
  /** 已唱色 */
  playedColor: ColorValue
  /** 未唱色 */
  unplayColor: ColorValue
}

const WordLyricLine = memo(({ line, size, lineHeight, textAlign, playedColor, unplayColor }: Props) => {
  const segments = line.segments
  const { played, resyncVersion } = useWordLyricProgress(line)
  const clipWidth = useRef(new Animated.Value(0)).current

  const [box, setBox] = useState({ width: 0, height: 0 })
  /** 每一段末尾的像素位置（相对行首文字起点） */
  const [ends, setEnds] = useState<number[] | null>(null)
  const measured = useRef<number[]>([])

  // 换行/换歌：段变了，之前量到的位置作废
  useEffect(() => {
    measured.current = []
    setEnds(null)
  }, [segments])

  const handleContainerLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout
    setBox((prev) =>
      Math.abs(prev.width - width) < 0.5 && Math.abs(prev.height - height) < 0.5 ? prev : { width, height })
  }

  const handleSegmentLayout = useCallback<SegmentLayout>((index, x, width) => {
    const next = measured.current
    next[index * 2] = x
    next[index * 2 + 1] = width
    if (next.length < segments.length * 2) return
    const positions: number[] = []
    for (let i = 0; i < segments.length; i++) {
      const start = next[i * 2]
      const size = next[i * 2 + 1]
      if (!Number.isFinite(start) || !Number.isFinite(size)) return
      positions.push(start + size)
    }
    setEnds((prev) => {
      if (prev && prev.length === positions.length && prev[prev.length - 1] === positions[positions.length - 1]) return prev
      return positions
    })
  }, [segments])

  const totalWidth = ends?.[ends.length - 1] ?? 0
  // 一行放得下 + 量到了宽度 + 高度对得上，才用扫光
  const canSweep = ends != null && totalWidth > 0 && box.width > 0 && box.height > 0 && totalWidth <= box.width

  // 扫光：每段开始时开一次线性动画，时长就是这一段的时长（照搬桌面版的 _refresh）
  useEffect(() => {
    if (!canSweep || !ends) return
    let isUnmounted = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const step = () => {
      if (isUnmounted) return
      const elapsed = wordLyricClock.positionAt(Date.now()) - line.timeMs
      // 当前正在唱的那一段（-1 表示还没开始，或落在两段之间的空隙里）
      let index = -1
      for (let i = 0; i < segments.length; i++) {
        if (segments[i].startMs > elapsed) break
        index = i
      }

      clipWidth.stopAnimation()
      const segment = index >= 0 ? segments[index] : null
      const remaining = segment ? segment.startMs + segment.durationMs - elapsed : 0
      if (segment && segment.durationMs > 0 && remaining > 0) {
        // 还在这段的时长里：线性扫到该段末尾（时长按倍速换算）
        Animated.timing(clipWidth, {
          toValue: ends[index] ?? 0,
          duration: Math.max(1, remaining / wordLyricClock.rate),
          easing: Easing.linear,
          useNativeDriver: false,
        }).start()
      } else {
        // 还没开始 / 落在空隙里 / 这一段已经唱完：直接摆到该在的位置
        clipWidth.setValue(sweepXAt(segments, ends, elapsed))
      }

      const next = nextBoundaryAt(segments, elapsed)
      if (next == null || !wordLyricClock.isPlay) return
      // 后台时没人看，别再唤醒自己；回到前台会重新锚定并重跑本 effect
      if (AppState.currentState === 'background') return
      timer = setTimeout(step, Math.max(16, (next - elapsed) / wordLyricClock.rate))
    }
    step()

    return () => {
      isUnmounted = true
      if (timer) clearTimeout(timer)
      clipWidth.stopAnimation()
    }
  }, [canSweep, ends, segments, line.timeMs, resyncVersion, clipWidth])

  // 兜底：逐段换色（一行放不下、或还没量到段宽时）。
  //
  // ⚠️ 这里**必须**也挂上测量行：段宽只有挂了 `onLayout` 才量得到，而扫光分支又要求
  // 先量到段宽才会渲染——测量行若只放在扫光分支里，两者互相等待，永远进不去扫光。
  // 真机上的表现就是「一个字一个字地换色，字内部不扫」（第一次实现踩过）。
  if (!canSweep) {
    return (
      <View onLayout={handleContainerLayout}>
        <View style={styles.measure} pointerEvents="none">
          <TextRow segments={segments} size={size} lineHeight={lineHeight} color={unplayColor} onSegmentLayout={handleSegmentLayout} />
        </View>
        <Text
          style={{ textAlign, lineHeight }}
          textBreakStrategy="simple"
          size={size}
          color={playedColor}
        >
          {segments.map((segment, index) => (
            <Text key={index} size={size} color={index < played ? playedColor : unplayColor}>{segment.text}</Text>
          ))}
        </Text>
      </View>
    )
  }

  // 扫光：两层同一行文字，上层（已唱色）被一个宽度随时间增长的盒子裁出来
  const left = textAlign === 'center'
    ? Math.max(0, (box.width - totalWidth) / 2)
    : textAlign === 'right'
      ? Math.max(0, box.width - totalWidth)
      : 0

  return (
    <View style={{ height: box.height }} onLayout={handleContainerLayout}>
      <View style={[styles.row, { left }]}>
        <TextRow segments={segments} size={size} lineHeight={lineHeight} color={unplayColor} onSegmentLayout={handleSegmentLayout} />
      </View>
      <Animated.View style={[styles.clip, { left, height: box.height, width: clipWidth }]}>
        <View style={[styles.row, { left: 0, width: totalWidth + 8 }]}>
          <TextRow segments={segments} size={size} lineHeight={lineHeight} color={playedColor} />
        </View>
      </Animated.View>
    </View>
  )
})

const styles = StyleSheet.create({
  row: {
    position: 'absolute',
    top: 0,
    flexDirection: 'row',
  },
  // 只用来量每一段的宽度与位置：不参与父容器排版，但自己会被正常布局（opacity 0 不影响布局）
  measure: {
    position: 'absolute',
    top: 0,
    left: 0,
    flexDirection: 'row',
    opacity: 0,
  },
  clip: {
    position: 'absolute',
    top: 0,
    overflow: 'hidden',
  },
})

export default WordLyricLine
