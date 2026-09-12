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
import { buildTips, dedupePreferLocal, searchTracks, type LibrarySearchResult } from './rank'
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

      state.tracks = dedupePreferLocal(tracks)
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

/**
 * 在本机曲库里搜索。
 *
 * 具体规则（排序、去重、结果形状）都在 `rank.ts` 里，且由 `rank.test.ts` 覆盖 ——
 * 那里是纯函数，Node 下跑得起来；本模块 import 了 `api.ts`，单测里跑不了。
 */
export function searchLibrary(text: string, page = 1, limit = 30): LibrarySearchResult {
  return searchTracks(state.tracks, text, page, limit, 'anylisten')
}

/** 输入联想的候选词，规则见 `rank.ts` 的 `buildTips`。 */
export function tipSearchLibrary(text: string, limit = 10): string[] {
  return buildTips(state.tracks, text, limit)
}

/** 取全部已缓存曲目（已按「同名优先本地」去重）。 */
export function getCachedTracks(): AnyListenMusicInfo[] {
  return state.tracks
}
