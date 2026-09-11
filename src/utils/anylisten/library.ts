/**
 * 客户端侧的曲库缓存。
 *
 * any-listen 服务端没有「按关键字搜歌」的接口，只有「列出歌单」和「列出歌单内的歌」。
 * 所以搜索只能在本机对已拉取的曲目做匹配。这个模块负责：
 *
 * 1. 按需拉取并对**全部歌单**的曲目建索引（用户 1653 首的库一次拉取约几百 KB）
 * 2. 提供关键字搜索
 * 3. 记录失败状态，让 UI 能区分「还没加载」与「加载失败」
 *
 * 缓存是**内存级**的，进程重启即失效；调用方通过 `ensureLoaded()` 触发加载。
 * 不落盘是有意的：曲库会变，落盘就要处理失效，而重新拉取的成本很低。
 */
import { getAllUserLists, getListMusics } from './api'
import { convertToSearchItem } from './convert'
import type { AnyListenMusicInfo } from './types'

export type LibraryStatus = 'idle' | 'loading' | 'ready' | 'error'

interface LibraryState {
  status: LibraryStatus
  error: string | null
  /** 全部曲目，按服务端返回顺序 */
  tracks: AnyListenMusicInfo[]
  loadedAt: number
}

const state: LibraryState = {
  status: 'idle',
  error: null,
  tracks: [],
  loadedAt: 0,
}

/** 正在进行的加载，用于合并并发请求 */
let inflight: Promise<void> | null = null

const listeners = new Set<(s: Readonly<LibraryState>) => void>()

export function getLibraryState(): Readonly<LibraryState> {
  return state
}

export function subscribeLibrary(listener: (s: Readonly<LibraryState>) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const l of listeners) l(state)
}

export function invalidateLibrary(): void {
  state.status = 'idle'
  state.tracks = []
  state.loadedAt = 0
  notify()
}

/**
 * 拉取全部歌单的曲目并去重。
 *
 * 去重按服务端 `id`：同一首歌可能同时出现在「全部歌曲」和某个季度歌单里。
 * 单个歌单失败不会让整体失败（那会让一个坏歌单拖垮整个搜索），
 * 但会记录在 `error` 里以便排查。
 */
export async function ensureLoaded(force = false): Promise<void> {
  if (!force && state.status === 'ready') return
  if (inflight) return inflight

  inflight = (async () => {
    state.status = 'loading'
    state.error = null
    notify()

    try {
      const all = await getAllUserLists()
      const listIds: string[] = []
      for (const list of [all.defaultList, all.loveList, all.lastPlayList, ...(all.userList ?? [])]) {
        if (list?.id && !listIds.includes(list.id)) listIds.push(list.id)
      }

      const seen = new Set<string>()
      const tracks: AnyListenMusicInfo[] = []
      const failures: string[] = []

      // 串行拉取：并发几十个请求对自建服务器压力大，而这里只做一次。
      for (const listId of listIds) {
        try {
          const musics = await getListMusics(listId)
          if (!Array.isArray(musics)) continue
          for (const m of musics) {
            if (!m || typeof m.id !== 'string' || seen.has(m.id)) continue
            seen.add(m.id)
            tracks.push(m)
          }
        } catch (err) {
          failures.push(`${listId}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      state.tracks = tracks
      state.loadedAt = Date.now()
      state.status = 'ready'
      if (failures.length) {
        state.error = `${failures.length} 个歌单拉取失败：${failures.slice(0, 3).join('；')}`
      }
      notify()
    } catch (err) {
      state.status = 'error'
      state.error = err instanceof Error ? err.message : String(err)
      notify()
    } finally {
      inflight = null
    }
  })()

  return inflight
}

const norm = (s: unknown): string => (typeof s === 'string' ? s.toLowerCase().trim() : '')

/** 去掉空格与常见标点，用于「把歌词当搜索词」这类输入。 */
const collapse = (s: string): string => s.replace(/[\s'",，。.、·\-_()（）\[\]【】!！?？~～]/g, '')

export interface LibrarySearchResult {
  list: ReturnType<typeof convertToSearchItem>[]
  total: number
  page: number
  limit: number
  allPage: number
}

/**
 * 在本机曲库里搜索。
 *
 * 排序策略：完全相等 > 前缀命中 > 歌名命中 > 歌手命中，同级按原顺序。
 * 不引入模糊算法：用户搜的基本是歌名/歌手，简单规则更好预测。
 */
export function searchLibrary(text: string, page = 1, limit = 30): LibrarySearchResult {
  const q = norm(text)
  if (!q) return { list: [], total: 0, page, limit, allPage: 1 }

  const qc = collapse(q)
  const scored: Array<{ track: AnyListenMusicInfo; score: number }> = []

  for (const track of state.tracks) {
    const name = norm(track.name)
    const singer = norm(track.singer)
    const album = norm(track.meta?.albumName)
    const nameC = collapse(name)
    const singerC = collapse(singer)

    let score = -1
    if (name === q) score = 0
    else if (name.startsWith(q) || nameC.startsWith(qc)) score = 1
    else if (name.includes(q) || (qc && nameC.includes(qc))) score = 2
    else if (singer.includes(q) || (qc && singerC.includes(qc))) score = 3
    else if (album && album.includes(q)) score = 4

    if (score >= 0) scored.push({ track, score })
  }

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
  }
}

/** 取全部已缓存曲目，供歌单适配器使用。 */
export function getCachedTracks(): AnyListenMusicInfo[] {
  return state.tracks
}
