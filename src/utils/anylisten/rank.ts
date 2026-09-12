/**
 * 本地曲库的搜索 / 联想 / 去重规则（纯函数，可在 Node 下单测）。
 *
 * 从 `library.ts` 里拆出来是为了**可测**：那个模块 import 了 `api.ts`，
 * 而 `api.ts` 会把设置 store 与 React Native 拖进来，Node 下跑不了。
 * 这里只依赖类型与 `convert.ts`（同样是纯的）。
 *
 * ## 为什么必须去重（真机实测）
 *
 * 服务端的曲库是**用户自己整理的**，同一首歌可能同时以多种形态存在：
 * 一个本地文件（`isLocal: true`，id 是文件路径）加上若干条在线引用
 * （`isLocal: false`，id 是 QQ 音乐 / 网易云的 songmid）。
 *
 * 用 `tools/ws-probe-library.mjs` 对真实服务器拉过一遍：1670 首里有 5 组
 * 同名同歌手的重复，共 8 条多余记录，全部是「本地文件 + 在线引用」的形态。
 * 表现就是搜索时同一首歌出现 2~3 次，而其中点不响的那些（服务端对在线曲目
 * 返回 `./gdstudio-no-url` 占位地址）会弹「该曲目可能已从曲库移除」。
 *
 * 所以规则是：**同一组里优先保留本地文件**。本地文件取址不依赖服务端去
 * 商业平台现拉，必定可播；而在线引用能不能取到要看服务端当时的状态
 * （实测同一首歌的在线引用有时能返回真实地址、有时是占位值）。
 */
import { convertToSearchItem } from './convert'
import type { AnyListenMusicInfo } from './types'

const norm = (s: unknown): string => (typeof s === 'string' ? s.toLowerCase().trim() : '')

/** 去掉空格与常见标点，用于「把歌词当搜索词」这类输入。 */
const collapse = (s: string): string => s.replace(/[\s'",，。.、·\-_()（）\[\]【】!！?？~～]/g, '')

/**
 * 归组用的键：同名 + 同歌手 + 同时长。
 *
 * 带上 `interval` 是为了不误伤「同名的不同版本」（例如原版与 Live）——
 * 时长不同就会被当成两首歌保留下来。
 */
function groupKey(track: AnyListenMusicInfo): string {
  return `${norm(track.name)}\u0000${norm(track.singer)}\u0000${norm(track.interval)}`
}

/** 更粗的键：只看同名 + 同歌手。 */
function songKey(track: AnyListenMusicInfo): string {
  return `${norm(track.name)}\u0000${norm(track.singer)}`
}

/**
 * 同一首歌只留一条，**优先本地文件**。分两步：
 *
 * 1. **本地文件优先**：只要某首歌有本地文件，就丢掉它同名的所有**在线引用**
 *    （不再比较时长）。真机数据里正是这一条消掉了全部 8 条多余记录：
 *    `可能 - 程响` 与 `COPDD - 宋雨琦…` 的在线引用时长与本地文件**不一致**，
 *    只比时长的规则会把它们留成第二行 —— 而界面上那两行的歌名歌手完全一样，
 *    用户只会看到「同一首歌出现两次」，其中一条还点不响。
 * 2. 再按「同名 + 同歌手 + 同时长」归组：这一步针对**没有**本地文件的情况
 *    （同一首歌在多个平台各有一条在线引用），以及本地文件之间恰好重名的情况。
 *
 * 保持首次出现的顺序；组内没有本地文件时保留第一条（无从判断优劣，
 * 至少不要丢掉这首歌）。
 */
export function dedupePreferLocal(tracks: AnyListenMusicInfo[]): AnyListenMusicInfo[] {
  const hasLocal = new Set<string>()
  for (const track of tracks) {
    if (track.isLocal === true) hasLocal.add(songKey(track))
  }

  // 第一步：丢掉「本地文件已覆盖」的在线引用
  const candidates = tracks.filter(track =>
    track.isLocal === true || !hasLocal.has(songKey(track)),
  )

  // 第二步：按同名 + 同歌手 + 同时长归组
  const groups = new Map<string, AnyListenMusicInfo[]>()
  const order: string[] = []

  for (const track of candidates) {
    const key = groupKey(track)
    const group = groups.get(key)
    if (group) {
      group.push(track)
    } else {
      groups.set(key, [track])
      order.push(key)
    }
  }

  const out: AnyListenMusicInfo[] = []
  for (const key of order) {
    const group = groups.get(key)!
    out.push(group.length === 1 ? group[0] : (group.find(t => t.isLocal === true) ?? group[0]))
  }
  return out
}

/**
 * 单条曲目的匹配得分。分数越小越靠前，`-1` 表示不匹配。
 *
 * 排序策略：完全相等 > 前缀命中 > 歌名命中 > 歌手命中 > 专辑命中，同级按原顺序。
 * 不引入模糊算法：用户搜的基本是歌名/歌手，简单规则更好预测。
 */
function scoreOf(name: string, singer: string, album: string, q: string, qc: string): number {
  const nameC = collapse(name)
  const singerC = collapse(singer)

  if (name === q) return 0
  if (name.startsWith(q) || (qc !== '' && nameC.startsWith(qc))) return 1
  if (name.includes(q) || (qc !== '' && nameC.includes(qc))) return 2
  if (singer.includes(q) || (qc !== '' && singerC.includes(qc))) return 3
  if (album !== '' && album.includes(q)) return 4
  return -1
}

export interface LibrarySearchResult {
  list: ReturnType<typeof convertToSearchItem>[]
  total: number
  page: number
  limit: number
  allPage: number
  /**
   * ⚠️ **必须有这个字段。**
   *
   * `store/search/music/action.ts` 的 `setList()` 用 `datas.source` 去
   * `state.listInfos[datas.source]` 取列表信息，再写 `listInfo.list`。
   * 缺了它就会在 `undefined` 上取属性 —— 单源搜索一按回车就抛
   * `TypeError: Cannot read property 'list' of undefined`，界面直接进错误态；
   * 而「聚合大会」那条分支遍历数组、恰好不读 `source`，所以看起来是好的。
   */
  source: string
}

/**
 * 在本机曲库里搜索。
 *
 * `sourceId` 会原样出现在返回值里 —— 上游各商业源的 `musicSearch.search`
 * 也都在结果里带上 `source`，`store/search/music/action.ts` 依赖它。
 */
export function searchTracks(
  tracks: AnyListenMusicInfo[],
  text: string,
  page = 1,
  limit = 30,
  sourceId = 'anylisten',
): LibrarySearchResult {
  const q = norm(text)
  if (!q) return { list: [], total: 0, page, limit, allPage: 1, source: sourceId }

  const qc = collapse(q)
  const scored: Array<{ track: AnyListenMusicInfo, score: number }> = []

  for (const track of tracks) {
    const score = scoreOf(
      norm(track.name),
      norm(track.singer),
      norm(track.meta?.albumName),
      q,
      qc,
    )
    if (score >= 0) scored.push({ track, score })
  }

  // sort 是稳定排序，同分时保持曲库原顺序
  scored.sort((a, b) => a.score - b.score)

  const total = scored.length
  const allPage = Math.max(1, Math.ceil(total / limit))
  const start = (page - 1) * limit
  const pageItems = scored.slice(start, start + limit)

  return {
    list: pageItems.map(({ track }) => convertToSearchItem(track)),
    total,
    page,
    limit,
    allPage,
    source: sourceId,
  }
}

/**
 * 输入联想。
 *
 * 返回的是**可以再次作为搜索词**的字符串：歌词/歌手名本身。
 *
 * 为什么不能返回「歌名 - 歌手」这种组合：联想项被点击后是直接拿它当搜索词
 * 走一遍 `searchTracks` 的，而「恋人 - 李荣浩」既不等于歌名也不被歌名包含，
 * 结果是点了联想项反而搜不到东西。
 */
export function buildTips(tracks: AnyListenMusicInfo[], text: string, limit = 10): string[] {
  const q = norm(text)
  if (!q) return []

  const scored: Array<{ value: string, score: number }> = []
  const seen = new Set<string>()

  const push = (raw: unknown, score: number) => {
    if (typeof raw !== 'string') return
    const value = raw.trim()
    if (!value) return
    const key = norm(value)
    if (seen.has(key)) return
    seen.add(key)
    scored.push({ value, score })
  }

  for (const track of tracks) {
    const name = norm(track.name)
    const singer = norm(track.singer)
    if (name.startsWith(q)) push(track.name, 0)
    else if (name.includes(q)) push(track.name, 1)
    if (singer.startsWith(q)) push(track.singer, 2)
    else if (singer.includes(q)) push(track.singer, 3)
  }

  scored.sort((a, b) => a.score - b.score)
  return scored.slice(0, limit).map(item => item.value)
}
