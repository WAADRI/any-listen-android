/**
 * 逐字歌词的**时间轴**：移植 lx-music-desktop / any-listen 的
 * `lyric-font-player/font-player.js`。
 *
 * ## 为什么要有这个文件（真机反馈的缺陷）
 *
 * 之前那版逐字歌词是「每 100ms 读一次本机播放位置，再把已唱段数写进 React state」，
 * 结果两个问题：
 *
 * 1. **生硬**：段的切换被量化到 100ms 网格上，字的颜色是硬切而不是扫过去；
 * 2. **卡顿**：每 100ms 触发一次 React 重渲染，Android 上改一个 Text span 的颜色
 *    会让整段文字的 Spannable 重建，于是歌词页面在滚动/动画时掉帧。
 *
 * 桌面版完全不是这么做的（`src/renderer/core/lyric.ts` + `line-player.js`）：
 * **播放位置只在 play / pause / seek 时取一次**，之后靠一个本地时钟推进，
 * 并且「一段开一次线性动画、时长就是这一段自己的时长」，动画跑在合成器上，
 * JS 只在每段开始时醒一次。所以它既不抖也不卡。
 *
 * 这里把同一套时间轴搬成纯函数 + 纯时钟（无 DOM、无 RN、无定时器），
 * 上面的确定义、单测可钉；RN 侧的动画与定时器只是它的壳（见
 * `screens/PlayDetail/components/WordLyricLine.tsx` 与
 * `utils/hooks/useWordLyricProgress.ts`）。
 *
 * ## 与桌面版的对应关系
 *
 * | 桌面版（font-player.js） | 这里 |
 * |---|---|
 * | `_currentTime()`：`(getNow() - _performanceTime) * rate + _startTime` | `AwlrcClock.positionAt()` |
 * | `play(curTime)`：重新起表 | `AwlrcClock.setPlay(true, now, pos)` / `resync()` |
 * | `pause()`：停表 | `AwlrcClock.setPlay(false, now)` |
 * | `font.animation.currentTime = driftTime`（跳进动画中段） | `sweepXAt()`（直接算出该时刻的像素位置） |
 * | `timeoutTools.start(..., delay)` 到下一段起点 | `nextBoundaryAt()` |
 * | 段动画 `duration = 段时长 / rate` | 调用方用 `(段结束时刻 - 当前时刻) / rate` 作为动画时长 |
 */
import type { AwlrcSegment } from './awlrc'

/**
 * 本地时钟：把「某个墙钟时刻对应播放器的哪个位置」记下来，之后自己线性推进。
 *
 * 播放位置只在重新锚定时从播放器读（与桌面版一致），其余时间不再问播放器——
 * 这正是逐字歌词不卡的原因。
 */
export class AwlrcClock {
  private anchorWall = 0
  private anchorPos = 0
  private _rate = 1
  private _isPlay = false

  get isPlay() {
    return this._isPlay
  }

  get rate() {
    return this._rate
  }

  /** 用播放器给出的位置（毫秒）在 `nowMs` 这个时刻重新起表。 */
  resync(positionMs: number, nowMs: number) {
    this.anchorWall = nowMs
    this.anchorPos = positionMs
  }

  /**
   * 播放/暂停。暂停时位置冻结在停表那一刻；恢复播放时**必须**顺带 `resync()`
   * 一次（调用方拿到的是播放器的真实位置），否则会把暂停期间的时间算进去。
   */
  setPlay(isPlay: boolean, nowMs: number, positionMs?: number) {
    if (positionMs != null) this.resync(positionMs, nowMs)
    this._isPlay = isPlay
  }

  /** 改倍速：先按旧倍速结算出当前位置，再以新倍速继续走。 */
  setRate(rate: number, nowMs: number) {
    const position = this.positionAt(nowMs)
    this._rate = rate > 0 ? rate : 1
    this.resync(position, nowMs)
  }

  /** `nowMs` 时刻的播放位置（毫秒）。 */
  positionAt(nowMs: number) {
    if (!this._isPlay) return this.anchorPos
    return this.anchorPos + (nowMs - this.anchorWall) * this._rate
  }
}

/**
 * `elapsedMs`（相对本行起始）时，扫光边界应该落在哪个像素位置。
 *
 * `ends` 是每一段**末尾**的像素位置（由调用方测量后累加得到），所以
 * 第 i 段的起点像素 = `ends[i-1]`（第 0 段是 0）。段的时长内线性推进，
 * 段与段之间的空隙保持不动（与桌面版一致：没有动画在跑）。
 *
 * 零时长段（实测里是标点）到点即整段扫完——对应桌面版 `duration = 0` 的动画
 * 立即结束。
 */
export const sweepXAt = (
  segments: readonly AwlrcSegment[],
  ends: readonly number[],
  elapsedMs: number,
): number => {
  let startX = 0
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    const endX = ends[i] ?? startX
    if (elapsedMs < segment.startMs) return startX // 还没唱到这一段
    const duration = segment.durationMs
    if (duration <= 0 || elapsedMs >= segment.startMs + duration) {
      startX = endX // 这一段（零时长或已过）整段算已唱
      continue
    }
    const progress = (elapsedMs - segment.startMs) / duration
    return startX + (endX - startX) * progress
  }
  return startX
}

/**
 * 下一个「段开始」的时刻（相对本行起始的毫秒），已无下一段则返回 `null`。
 *
 * 调用方据此排一个定时器：到点再开下一段的动画。**段结束不需要定时器**——
 * 动画自己会在段时长用完时停在那一格。
 */
export const nextBoundaryAt = (
  segments: readonly AwlrcSegment[],
  elapsedMs: number,
): number | null => {
  for (const segment of segments) {
    if (segment.startMs > elapsedMs) return segment.startMs
  }
  return null
}

/** 本行唱完的时刻（最后一段的结束时间）。没有段时为 0。 */
export const lineEndAt = (segments: readonly AwlrcSegment[]): number => {
  let end = 0
  for (const segment of segments) {
    const segmentEnd = segment.startMs + segment.durationMs
    if (segmentEnd > end) end = segmentEnd
  }
  return end
}
