import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, AppState, Easing, StyleSheet, View, type ColorValue, type LayoutChangeEvent, type TextStyle } from 'react-native'
import Text from '@/components/common/Text'
import { type AwlrcLine, type AwlrcSegment } from '@/utils/awlrc'
import { layoutSweepRows, nextBoundaryAt, sweepXAt } from '@/utils/awlrcPlayer'
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
 * **同一行画两遍**——下面是未唱色，上面是已唱色，已唱色的字放进 `overflow: hidden`
 * 的盒子里，盒子宽度随时间线性增长，于是「已唱色从左往右扫出来」。两层文字位置完全
 * 相同、都不动，边界是硬切，和桌面版 `background-size` 的硬边界一致。
 *
 * ## 折行的长句也能扫（每个视觉行一个 clip 条）
 *
 * 长句折成两行后，第二行的字在水平方向上与第一行重叠，一个水平矩形没法只照亮
 * 「第一行的全部 + 第二行的开头」。做法是把裁剪拆到**每个视觉行**：先按段宽贪心
 * 断行（`layoutSweepRows`），段按 `(行偏移 + 行内偏移, 行号 × 行高)` 绝对定位；
 * 上层每个视觉行一个 clip 条，条内只放该行的段。所有条共用一个「全局像素进度」
 * 动画值——第 r 行的 clip 宽度 = 进度在该行区间上的 clamp 插值，于是视觉上就是
 * 第一行扫满、接着第二行从零继续扫，边界连续。
 *
 * 时间轴照搬桌面版：播放位置只在 play / pause / seek / 换行时读一次，之后靠
 * `wordLyricClock` 自己走，每段开始时开一次线性动画、时长就是这一段自己的时长
 * （见 `utils/awlrcPlayer.ts`）。**动画期间不触发任何 React 重渲染。**
 *
 * ## 什么时候退回「逐段换色」
 *
 * - 段宽还没量到，或某个段自己就比整行还宽（断不下去）；
 * - 防御性检查失败（段宽非法、行宽为 0）。
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
  const progress = useRef(new Animated.Value(0)).current

  const [box, setBox] = useState({ width: 0, height: 0 })
  /** 每段的固有宽度（含段文本自带的尾随空格） */
  const [widths, setWidths] = useState<number[] | null>(null)
  const measured = useRef<number[]>([])

  // 换行/换歌：段变了，之前量到的宽度作废
  useEffect(() => {
    measured.current = []
    setWidths(null)
  }, [segments])

  const handleContainerLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout
    setBox((prev) =>
      Math.abs(prev.width - width) < 0.5 && Math.abs(prev.height - height) < 0.5 ? prev : { width, height })
  }

  const handleSegmentLayout = useCallback<SegmentLayout>((index, _x, width) => {
    const next = measured.current
    next[index] = width
    if (next.length < segments.length) return
    const widths: number[] = []
    for (let i = 0; i < segments.length; i++) {
      if (!Number.isFinite(next[i])) return
      widths.push(next[i])
    }
    setWidths((prev) => {
      if (prev && prev.length === widths.length && prev[prev.length - 1] === widths[widths.length - 1]) return prev
      return widths
    })
  }, [segments])

  const layout = useMemo(
    () => widths != null && box.width > 0 ? layoutSweepRows(widths, box.width) : null,
    [widths, box.width],
  )
  // 贪心断行保证除首段外每段都放得下，所以「行宽超出」只可能是单个段比整行还宽；
  // 行宽为 0 会让 interpolate 的 inputRange 两点重合。两种都退回逐段换色。
  const canSweep = layout != null &&
    layout.rows.length > 0 &&
    layout.rows.every((row) => row.width > 0 && row.width <= box.width)

  // 扫光：每段开始时开一次线性动画，时长就是这一段的时长（照搬桌面版的 _refresh）
  useEffect(() => {
    if (!canSweep || !layout) return
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

      progress.stopAnimation()
      const segment = index >= 0 ? segments[index] : null
      const remaining = segment ? segment.startMs + segment.durationMs - elapsed : 0
      if (segment && segment.durationMs > 0 && remaining > 0 && wordLyricClock.isPlay) {
        // 还在这段的时长里：线性扫到该段末尾（时长按倍速换算；toValue 是全局像素）
        Animated.timing(progress, {
          toValue: layout.globalEnds[index] ?? 0,
          duration: Math.max(1, remaining / wordLyricClock.rate),
          easing: Easing.linear,
          useNativeDriver: false,
        }).start()
      } else {
        // 还没开始 / 落在空隙里 / 这一段已经唱完 —— 以及**暂停**：
        // 暂停时必须直接摆到当前位置，不能把这一段动画跑完，否则暂停后字还会被扫完
        progress.setValue(sweepXAt(segments, layout.globalEnds, elapsed))
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
      progress.stopAnimation()
    }
  }, [canSweep, layout, segments, line.timeMs, resyncVersion, progress])

  // 每个视觉行一个 clip 宽度：全局进度落到 [progressStart, progressStart+width]
  // 区间内的 clamp 插值（前面的行扫满停住、后面的行没扫到保持 0）
  const clipWidths = useMemo(() => {
    if (!layout) return null
    return layout.rows.map((row) => progress.interpolate({
      inputRange: [row.progressStart, row.progressStart + row.width],
      outputRange: [0, row.width],
    }))
  }, [layout, progress])

  // 扫光分支里挂在下层段上的测量回调：宽度变了才更新（handler 里只认宽度，
  // 段被重新定位时 x 会变，不参与比较，所以不会形成「布局→测量→布局」的环）
  const onBaseSegmentLayout = useCallback((index: number) => (event: { nativeEvent: { layout: { x: number, width: number } } }) => {
    handleSegmentLayout(index, event.nativeEvent.layout.x, event.nativeEvent.layout.width)
  }, [handleSegmentLayout])

  // 兜底：逐段换色（段宽还没量到、或单段超宽断不下去时）。
  //
  // ⚠️ 这里**必须**也挂上测量行：段宽只有挂了 `onLayout` 才量得到，而扫光分支又要求
  // 先量到段宽才会渲染——测量行若只放在扫光分支里，两者互相等待，永远进不去扫光。
  // 真机上的表现就是「一个字一个字地换色，字内部不扫」（第一次实现踩过）。
  if (!canSweep || !layout || !clipWidths) {
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

  // 扫光：两层同一行文字。上层（已唱色）按视觉行拆进 overflow hidden 的 clip 条里，
  // 条宽随全局进度增长；下层（未唱色）整行绝对定位。
  const rowLeft = (rowWidth: number): number => textAlign === 'center'
    ? Math.max(0, (box.width - rowWidth) / 2)
    : textAlign === 'right'
      ? Math.max(0, box.width - rowWidth)
      : 0

  return (
    <View style={{ height: layout.rows.length * lineHeight }} onLayout={handleContainerLayout}>
      {/* 下层：未唱色，每段绝对定位（行对齐偏移 + 行内偏移，行号 × 行高）。
          段上仍挂测量回调：扫光分支没有测量行，字号/字号设置变化时靠这里重测段宽 */}
      {layout.rows.map((row, r) => (
        <View
          key={`base-${r}`}
          style={[styles.row, { left: rowLeft(row.width), top: r * lineHeight, width: row.width, height: lineHeight }]}
        >
          {segments.slice(row.from, row.to).map((segment, i) => (
            <Text
              key={row.from + i}
              size={size}
              color={unplayColor}
              numberOfLines={1}
              onLayout={onBaseSegmentLayout(row.from + i)}
              style={{ position: 'absolute', left: row.offsets[i], top: 0, lineHeight }}
            >{segment.text}</Text>
          ))}
        </View>
      ))}
      {/* 上层：已唱色。每个视觉行一个 clip 条，条内段的坐标相对条自身 */}
      {layout.rows.map((row, r) => (
        <Animated.View
          key={`clip-${r}`}
          style={[styles.clip, { left: rowLeft(row.width), top: r * lineHeight, height: lineHeight, width: clipWidths[r] }]}
        >
          {segments.slice(row.from, row.to).map((segment, i) => (
            <Text
              key={row.from + i}
              size={size}
              color={playedColor}
              numberOfLines={1}
              style={{ position: 'absolute', left: row.offsets[i], top: 0, lineHeight }}
            >{segment.text}</Text>
          ))}
        </Animated.View>
      ))}
    </View>
  )
})

const styles = StyleSheet.create({
  // 下层每视觉行的定位框：只做定位容器，段在里面绝对排布
  row: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  // 只用来量每一段的宽度：不参与父容器排版，但自己会被正常布局（opacity 0 不影响布局）
  measure: {
    position: 'absolute',
    top: 0,
    left: 0,
    flexDirection: 'row',
    opacity: 0,
  },
  clip: {
    position: 'absolute',
    overflow: 'hidden',
  },
})

export default WordLyricLine
