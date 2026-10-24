import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Animated, AppState, Easing, StyleSheet, View, type ColorValue, type LayoutChangeEvent, type TextStyle } from 'react-native'
import Text from '@/components/common/Text'
import { log } from '@/utils/log'
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
 * 断行（`layoutSweepRows`），每个视觉行一个行框（绝对定位到行位置）；上层每个
 * 视觉行一个 clip 条，所有条共用一个「全局像素进度」动画值——第 r 行的 clip 宽度
 * = 进度在该行区间上的 clamp 插值，于是视觉上就是第一行扫满、接着第二行从零
 * 继续扫，边界连续。
 *
 * ⚠️ clip 条（以及下层行框）内的段**必须流式排布，不能绝对定位**：宽度动画 +
 * 绝对定位子元素在 Android 上会出现部分区域不重绘（宽度/高度不在原生动画优化
 * 的属性集里）——真机上表现为「第一个字只有下半跟着扫，上半要等下一段动画
 * start 时才瞬间补上」。旧单行实现的 clip 内一直是流式排布，没有此问题。
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
  const loggedFirstStepRef = useRef(false)
  useEffect(() => {
    if (!canSweep || !layout) return
    let isUnmounted = false
    let timer: ReturnType<typeof setTimeout> | null = null
    loggedFirstStepRef.current = false

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
        if (!loggedFirstStepRef.current) {
          loggedFirstStepRef.current = true
          // stopAnimation 已在上面停表，动画起点就是 progress 当前值（日志用）
          log.info(`[lyric] 扫光首帧(动画) 行=${line.timeMs}ms elapsed=${Math.round(elapsed)}ms 段=${index} 剩余=${Math.round(remaining)}ms`)
        }
        Animated.timing(progress, {
          toValue: layout.globalEnds[index] ?? 0,
          duration: Math.max(1, remaining / wordLyricClock.rate),
          easing: Easing.linear,
          useNativeDriver: false,
        }).start()
      } else {
        // 还没开始 / 落在空隙里 / 这一段已经唱完 —— 以及**暂停**：
        // 暂停时必须直接摆到当前位置，不能把这一段动画跑完，否则暂停后字还会被扫完
        if (!loggedFirstStepRef.current) {
          loggedFirstStepRef.current = true
          log.info(`[lyric] 扫光首帧(直达) 行=${line.timeMs}ms elapsed=${Math.round(elapsed)}ms 段=${index} isPlay=${wordLyricClock.isPlay}`)
        }
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
  // 条宽随全局进度增长；下层（未唱色）同结构。两层行内的段都流式排布（见文件头
  // 的 ⚠️：绝对定位 + 宽度动画在 Android 上部分区域不重绘）。
  const rowLeft = (rowWidth: number): number => textAlign === 'center'
    ? Math.max(0, (box.width - rowWidth) / 2)
    : textAlign === 'right'
      ? Math.max(0, box.width - rowWidth)
      : 0

  return (
    <View style={{ height: layout.rows.length * lineHeight }} onLayout={handleContainerLayout}>
      {/* 下层：未唱色。行框绝对定位到行位置，段在框内流式排布。
          行框内挂测量回调（带 row.from 偏移）：扫光分支没有测量行，
          字号/字号设置变化时靠这里重测段宽 */}
      {layout.rows.map((row, r) => (
        <View key={`base-${r}`} style={[styles.row, { left: rowLeft(row.width), top: r * lineHeight }]}>
          <TextRow
            segments={segments.slice(row.from, row.to)}
            size={size}
            lineHeight={lineHeight}
            color={unplayColor}
            onSegmentLayout={(index, x, width) => { handleSegmentLayout(row.from + index, x, width) }}
          />
        </View>
      ))}
      {/* 上层：已唱色。每个视觉行一个 clip 条，条内放该行的段（流式，起点与行框一致）。
          条内先包一层固定宽度的行容器：内容布局与 clip 的宽度动画彻底解耦（旧单行
          实现同款结构，+8 是给 textShadow/字形边缘留的余量） */}
      {layout.rows.map((row, r) => (
        <Animated.View
          key={`clip-${r}`}
          style={[styles.clip, { left: rowLeft(row.width), top: r * lineHeight, height: lineHeight, width: clipWidths[r] }]}
        >
          <View style={[styles.row, { left: 0, top: 0, width: row.width + 8 }]}>
            <TextRow segments={segments.slice(row.from, row.to)} size={size} lineHeight={lineHeight} color={playedColor} />
          </View>
        </Animated.View>
      ))}
    </View>
  )
})

const styles = StyleSheet.create({
  // 下层每视觉行的定位框：框绝对定位到行位置，段在框内横向流式排布
  row: {
    position: 'absolute',
    left: 0,
    top: 0,
    flexDirection: 'row',
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
