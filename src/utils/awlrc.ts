/**
 * 逐字歌词（any-listen 的 `awlyric`）解析。
 *
 * ## 格式（实测自本项目的服务器，见 `tools/ws-probe-awlrc.mjs`）
 *
 * ```
 * [offset:0]
 * [00:00.111]<0,302>2026<302,179>一<481,176>定<657,174>会<831,178>幸…
 * [00:02.223]<0,150>词<150,0>：<150,153>諾<303,153>然
 * ```
 *
 * - `<\d+,\d+>` 的两个数是 **相对本行的起始毫秒** 与 **该段时长毫秒**，
 *   段本身跟在标签**后面**（所以标签是「前置」的）；
 * - 段可以**零时长**（`<150,0>`），实测里是标点那类；
 * - 行时间戳是普通 LRC `[mm:ss.xxx]`，可带 `[offset:N]` 标签（毫秒，正值延后）；
 * - 一行里**只要有一段没有前置标签**（例如行首有散字），整行退回「逐行」模式 ——
 *   这是 any-listen 的 `FontPlayer._handleLineParse` 的行为，这里保持一致。
 *
 * 实测校验：每行末段结束时间与下一行的间隔**完全吻合**（`2112ms` vs `2112ms`），
 * 佐证「段相对本行」这一前提。
 *
 * ## 与 any-listen 的关系
 *
 * 解析规则照搬 `packages/shared/web/lyric-font-player/font-player.js` 的
 * `_parseLyric()` 与 `line-player.js` 的 `_initLines()` / `_initTag()`，
 * 但没有照搬它的渲染：那边用 CSS `backgroundSize` 动画逐段扫过，
 * RN 这边改为**逐段着色**（服务端是按字切段，效果等价）。
 */
import type { AnyListenLyricInfo } from './anylisten/types'

export interface AwlrcSegment {
  /** 该段的文字 */
  text: string
  /** 相对**本行**起始的毫秒偏移 */
  startMs: number
  /** 该段时长（毫秒）；实测可能为 0 */
  durationMs: number
}

export interface AwlrcLine {
  /** 该行的绝对时间（已加上 `[offset:N]`），毫秒 */
  timeMs: number
  /** 去掉所有 `<>` 标签后的正文（等于各段文字拼接） */
  text: string
  /**
   * 逐字段。为空表示这一行不是逐字行（`hasWordTiming` 为 false），
   * 渲染时应退回普通整行显示。
   */
  segments: AwlrcSegment[]
}

export interface Awlrc {
  lines: AwlrcLine[]
  /** 按绝对时间索引，渲染时用来按行时间取段 */
  byTime: Map<number, AwlrcLine>
  /** 是否至少有一行带逐字时间（否则整首按逐行处理） */
  hasWordTiming: boolean
}

const TIME_FIELD = /^(?:\[[\d:.]+\])+/
const OFFSET_TAG = /\[offset:\s*(-?\d+)\s*]/i
const SEGMENT_TAG = /<(\d+),(\d+)>/g

/** 把 `mm:ss.xxx` / `hh:mm:ss.xxx` 解析成毫秒。解析不出来返回 null。 */
export function parseTimeLabel(label: string): number | null {
  const parts = label.replace(/[[\]]/g, '').split(':')
  if (parts.length > 3) return null
  while (parts.length < 3) parts.unshift('0')
  const [h, m, rest] = parts
  const [sec, ms = '0'] = rest.split('.')
  const hh = parseInt(h, 10)
  const mm = parseInt(m, 10)
  const ss = parseInt(sec, 10)
  const msec = parseInt(ms.padEnd(3, '0').slice(0, 3), 10)
  if (Number.isNaN(hh) || Number.isNaN(mm) || Number.isNaN(ss) || Number.isNaN(msec)) return null
  return hh * 3600_000 + mm * 60_000 + ss * 1000 + msec
}

/**
 * 解析一行的正文，切成逐字段。
 *
 * 返回 `null` 表示这一行**不是**逐字行（行首有非标签文字，或根本没有标签）。
 */
function parseSegments(text: string): AwlrcSegment[] | null {
  SEGMENT_TAG.lastIndex = 0
  const markers = [...text.matchAll(SEGMENT_TAG)]
  if (!markers.length) return null
  // 第一个标签必须就在行首：any-listen 用前瞻切分，行首散字会让第一段没有标签，
  // 从而整行退回逐行模式。这里显式写出来，避免行为漂移。
  if (markers[0].index !== 0) return null

  const segments: AwlrcSegment[] = []
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i]
    const from = (marker.index ?? 0) + marker[0].length
    const to = i + 1 < markers.length ? (markers[i + 1].index ?? text.length) : text.length
    segments.push({
      text: text.slice(from, to),
      startMs: parseInt(marker[1], 10),
      durationMs: parseInt(marker[2], 10),
    })
  }
  return segments
}

/**
 * 解析逐字歌词全文。
 *
 * 没有逐字信息的行会被保留（`segments: []`、`text` 为去掉标签后的正文），
 * 这样调用方仍能按行号/时间对齐行列表。
 */
export function parseAwlrc(awlrc: string | null | undefined): Awlrc {
  const empty: Awlrc = { lines: [], byTime: new Map(), hasWordTiming: false }
  if (typeof awlrc !== 'string' || !awlrc) return empty

  // [offset:N] 对整首都生效（any-listen 的 _initTag 也是全局偏移）
  const offsetMatch = OFFSET_TAG.exec(awlrc)
  const offset = offsetMatch ? (parseInt(offsetMatch[1], 10) || 0) : 0

  const lines: AwlrcLine[] = []
  const byTime = new Map<number, AwlrcLine>()
  let hasWordTiming = false

  for (const raw of awlrc.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line) continue
    const timeField = TIME_FIELD.exec(line)
    if (!timeField) continue // `[offset:0]` 这类纯标签行
    const rest = line.slice(timeField[0].length).trim()
    if (!rest || rest === '//') continue

    const segments = parseSegments(rest)
    const text = segments ? segments.map(s => s.text).join('') : rest.replace(SEGMENT_TAG, '')
    if (!text.trim()) continue

    // 一行可能有多个时间戳（同一句重复出现）：与 any-listen 一致，逐个建行
    for (const label of timeField[0].match(/\[[\d:.]+\]/g) ?? []) {
      const timeMs = parseTimeLabel(label)
      if (timeMs == null) continue
      const entry: AwlrcLine = { timeMs: timeMs + offset, text, segments: segments ?? [] }
      lines.push(entry)
      byTime.set(entry.timeMs, entry)
      if (entry.segments.length) hasWordTiming = true
    }
  }

  lines.sort((a, b) => a.timeMs - b.timeMs)
  return { lines, byTime, hasWordTiming }
}

/** 从服务端返回的歌词对象里取逐字歌词（字段名是 `awlyric`）。 */
export function awlrcOf(info: Pick<AnyListenLyricInfo, 'awlyric'> | null | undefined): string {
  return typeof info?.awlyric === 'string' ? info.awlyric : ''
}

/** 原生桌面歌词需要的逐字信息：`[[行时间, [[段起始, 段时长, 段文字], ...], 行正文], ...]` */
export type NativeWordLine = [number, [number, number, string][], string]

/**
 * 转成原生悬浮歌词窗口用的嵌套数组。
 *
 * 桌面歌词是原生控件（`android/.../lyric/LyricModule.java`），它自己按 LRC 切行、
 * 自己走时钟，所以要把「每行的逐字段」交给它。**解析仍然在 JS 侧做**（这里有单测与
 * 真实数据样本），原生只负责按时间把位置画出来——两边别各写一份解析器。
 *
 * 没有逐字信息的行不传：那些行本来就该整行上色。
 */
export function toNativeWordLines(awlrc: Awlrc): NativeWordLine[] {
  const lines: NativeWordLine[] = []
  for (const line of awlrc.lines) {
    if (!line.segments.length) continue
    lines.push([
      line.timeMs,
      line.segments.map(segment => [segment.startMs, segment.durationMs, segment.text] as [number, number, string]),
      line.text,
    ])
  }
  return lines
}

/**
 * 描出当前已唱到第几段。
 *
 * `elapsedMs` 是**相对本行起始**的时间。返回值是「已唱完/正在唱的段数」，
 * 渲染时 `index < playedCount` 的段用已唱色，其余用未唱色。
 *
 * 段一旦到点就算已唱（服务端按字切段，所以视觉上仍是逐字推进）；
 * 零时长的段同样在到点时立即算已唱。
 */
export function playedCount(segments: readonly AwlrcSegment[], elapsedMs: number): number {
  let count = 0
  for (const seg of segments) {
    if (elapsedMs >= seg.startMs) count++
    else break
  }
  return count
}

/**
 * 这一行该怎么上色。
 *
 * - `active`：当前正在唱的行 —— 逐字扫光；
 * - `sung`：**已经唱过**的逐字行 —— 整行保持已唱色；
 * - `idle`：还没唱到的行（以及没有逐字信息的行）—— 普通未激活色。
 *
 * `sung` 这条是照桌面版来的：lx-music-desktop 的 `lyric-font-player` 在换行时
 * 对被越过的行调 `font.finish()`，并把 `.played` 加到行上，CSS 是
 * `&.font-mode.played .font-lrc { color: @played-color }` —— 也就是说**唱过的行
 * 不会退回未唱色**，扫光只是「填满了」。真机上少了这条，用户会看到已唱的歌词
 * 一过当前行就整行变灰、扫光像被擦掉了。
 */
export const lineStyleKind = (
  lineNum: number,
  activeLine: number,
  isWordLine: boolean,
): 'active' | 'sung' | 'idle' => {
  if (activeLine < 0) return 'idle'
  if (lineNum === activeLine) return 'active'
  return isWordLine && lineNum < activeLine ? 'sung' : 'idle'
}

/**
 * 按行时间取逐字段，取不到再退化为按行号取。
 *
 * 两套行列表（普通歌词由 `lrc-file-parser` 解析、逐字由本模块解析）虽然同源，
 * 但排序/去重规则未必完全一致，所以先按时间精确匹配，再按序号兜底。
 *
 * 传了 `lineText` 就要求正文完全一致：兜底是按序号取的，万一两套列表错位，
 * 宁可退回逐行显示，也不能把**别的行的字**按这一行的时间涂上色。
 *
 * @param lineIndex 普通歌词里的行号
 * @param lineTimeMs 普通歌词里的行时间（毫秒），没有就传 undefined
 * @param lineText 普通歌词里的正文，用于校验
 */
export function findAwlrcLine(
  awlrc: Awlrc,
  lineIndex: number,
  lineTimeMs: number | undefined,
  lineText?: string,
): AwlrcLine | undefined {
  const isSameLine = (entry: AwlrcLine | undefined): entry is AwlrcLine =>
    entry != null && (lineText == null || entry.text === lineText)
  if (lineTimeMs != null) {
    const hit = awlrc.byTime.get(lineTimeMs)
    if (isSameLine(hit)) return hit
  }
  const byIndex = awlrc.lines[lineIndex]
  return isSameLine(byIndex) ? byIndex : undefined
}
