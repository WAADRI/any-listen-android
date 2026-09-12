/**
 * any-listen 的歌单界面数据源。
 *
 * ## 为什么实现这个接口而不是重写界面
 *
 * lx 的歌单浏览界面（歌单广场 + 歌单详情，含「播放全部」「下载」「批量操作」）
 * 全部通过 lx 的**源层 `songList` 接口**取数据，而 `core/songlist.ts` 只用到其中
 * **三个方法**：
 *
 * | 方法 | 调用点 | 作用 |
 * |---|---|---|
 * | `getTags()` | `core/songlist.ts:31` | 分类标签 |
 * | `getList(sortId, tagId, page)` | `core/songlist.ts:80` | 歌单列表 |
 * | `getListDetail(id, page)` | `core/songlist.ts:109` | 歌单内歌曲 |
 *
 * 因此只要这三个方法按契约返回，**整个歌单界面不需要改一行代码**就能用。
 * 这比重写界面可靠得多，也让「播放全部」等现成功能直接可用。
 *
 * ## 与商业音源的语义差异
 *
 * 商业音源的 `getList` 是「浏览平台推荐的歌单广场」，有分类、排序、热度。
 * any-listen 没有这些东西 —— 它就是**你自己的歌单**。映射关系：
 *
 * - `getList` → `getAllUserLists()`：你自己的全部歌单
 * - `getListDetail` → `getListMusics(id)`：某个歌单里的歌曲
 * - `getTags` → 返回空标签：没有可筛选的分类，界面会显示为「全部」一项
 *
 * `sortList` 也只保留一个「全部」项，否则界面会显示一排点了没反应的排序按钮。
 *
 * ## 分页
 *
 * 服务端**一次返回整个歌单**（「全部歌曲」有 1653 首），没有分页参数。
 * 所以这里在本地切页：一次全量拉取后缓存，再按 `PAGE_SIZE` 切片。
 * 不这么做的话，`core/songlist.ts:129` 的
 * `sourcePage < Math.ceil(result.total / result.limit)` 会误判还有下一页，
 * 导致反复请求同一个完整歌单。
 */
import { getAllUserLists, getListMusics, getSession } from '../../anylisten/api'
import { convertToSearchItem } from '../../anylisten/convert'
import { resolveServerUrl } from '../../anylisten/serverUrl'
import type { AnyListenMusicInfo, AnyListenUserList, AnyListenMyAllList } from '../../anylisten/types'

type ListInfoItem = import('@/store/songlist/state').ListInfoItem
type ListInfo = import('@/store/songlist/state').ListInfo
type ListDetailInfo = import('@/store/songlist/state').ListDetailInfo

/** 本地每页条数。取值只需与 `core/songlist.ts` 的 LIST_LOAD_LIMIT 无关即可。 */
const PAGE_SIZE = 50

/**
 * 排序选项。
 *
 * 只放一项，且 `tid` 必须是 `SortInfo` 允许的取值。
 * 放多项的话界面会出现几个点了没有任何变化的排序按钮。
 */
export const sortList = [
  { name: '全部', tid: 'new' as const, id: 'all' },
]

/**
 * 歌单内歌曲的缓存。
 *
 * 必要性：本地分页意味着同一歌单会被反复请求（用户往回翻页、界面重建）。
 * 每页都重新拉一次 1653 首会非常慢，而且服务端没有分页可用。
 */
const detailCache = new Map<string, AnyListenMusicInfo[]>()

/** 测试或切换服务器后需要丢弃缓存。 */
export const clearSongListCache = () => { detailCache.clear() }

/**
 * 取服务端曲目列表，带缓存。
 *
 * 用 `getSession().serverUrl` 而不是注入的 provider：本模块只在连接成功后
 * 才会被调用，此时会话一定存在；而缓存的 key 必须包含服务器地址，
 * 否则切换服务器后会把旧服务器的歌单当成新的返回。
 */
async function loadTracks(listId: string, force = false): Promise<AnyListenMusicInfo[]> {
  const cacheKey = `${getSession().serverUrl ?? ''}\u0000${listId}`
  if (!force) {
    const hit = detailCache.get(cacheKey)
    if (hit) return hit
  }
  // `getListMusics` 返回的是**裸数组**（见 types.ts 的 `AnyListenMusicList`），
  // 不是 `{ list: [...] }` 信封。这里曾经写成 `result?.list` —— 在数组上读
  // 不存在的属性不会报错、只会得到 undefined，于是歌单详情永远是空的。
  // 这类错误类型系统也拦不住：数组上本来就可以做属性访问。
  const result = await getListMusics(listId)
  const tracks = Array.isArray(result) ? result : []
  detailCache.set(cacheKey, tracks)
  return tracks
}

/**
 * 把服务端歌单转成界面的列表项。
 *
 * 字段以**实测**为准（`meta` 的真实键是
 * `deviceId / path / includeSubDir / lazzyParseMeta / createTime / updateTime /
 * desc / playCount / posTime / enabledRemove / songCount`）：
 *
 * - **没有 `img`**：any-listen 的歌单不存封面，服务端不提供。界面会显示占位图。
 * - **没有 `author`**：没有创建者概念。留空字符串，不要编造。
 * - **没有 `time`**：没有创建时间字符串。界面用 `total` 显示歌曲数代替。
 *
 * 这些字段是「有则有、无则空」，所以不能用 `?? ''` 之外的默认值去填，
 * 那样会显示假信息。
 */
function toListItem(list: AnyListenUserList, serverUrl: string): ListInfoItem {
  const cover = resolveServerUrl(list.meta?.picUrl, serverUrl) ?? ''
  // 实测 meta 里没有 picUrl；只有极少数形态才有。有就解析，没有就留空。
  return {
    id: list.id,
    name: list.name || '未命名歌单',
    author: list.meta?.path ?? '',
    img: cover,
    desc: list.meta?.desc ?? '',
    time: typeof list.meta?.createTime === 'number'
      ? new Date(list.meta.createTime).toLocaleDateString()
      : undefined,
    // 界面用它显示歌曲数
    total: typeof list.meta?.songCount === 'number' ? String(list.meta.songCount) : undefined,
    source: 'anylisten',
  }
}

/**
 * 展开 `getAllUserLists` 的返回。
 *
 * 返回结构是 `{ defaultList, loveList, lastPlayList, userList }` —— **不是数组**，
 * 真实的用户歌单在 `userList` 里。（一开始按 `result.list` 读，那永远是空的。）
 *
 * ## 为什么要用 `enabledRemove` 过滤
 *
 * 实测「全部歌曲」（`type: 'local'`，即服务端主机上挂载的 `/music` 文件夹）
 * 的 `meta.enabledRemove` 是 `false`，而用户手建的歌单是 `true`。
 * 这正是「哪些歌单该出现在浏览列表里」的天然标记：文件夹映射与内置列表
 * 用户既不能改名也不能删除，把它们混进歌单列表只会让人困惑。
 */
function expandLists(all: AnyListenMyAllList | undefined | null): AnyListenUserList[] {
  if (!all) return []
  const builtin = [all.defaultList, all.loveList, all.lastPlayList]
  const users = Array.isArray(all.userList) ? all.userList : []
  return [...builtin, ...users].filter((list): list is AnyListenUserList => {
    if (!list || typeof list.id !== 'string') return false
    // 只保留可管理的歌单；`enabledRemove === false` 的是文件夹映射或内置项
    return list.meta?.enabledRemove !== false
  })
}

/**
 * 分类标签。
 *
 * any-listen 没有歌单分类，所以返回空列表。
 * 不能返回 `null`/省略 —— `core/songlist.ts:32` 会把它写进 store，
 * 而界面会读取 `tags` 数组，缺字段会崩。
 */
export const getTags = async(): Promise<{
  tags: Array<{ name: string, list: Array<{ parent_id: string, parent_name: string, id: string, name: string, source: 'anylisten' }> }>
  hotTag: Array<{ parent_id: string, parent_name: string, id: string, name: string, source: 'anylisten' }>
  source: 'anylisten'
}> => ({
  tags: [],
  hotTag: [],
  source: 'anylisten',
})

/**
 * 歌单列表。
 *
 * `total` / `limit` / `maxPage` 三者必须自洽：
 * `core/songlist.ts` 用 `Math.ceil(total / limit)` 判断是否还有下一页，
 * 填错会导致无限加载或提前截断。
 */
export const getList = async(sortId: string, tagId: string, page: number): Promise<ListInfo> => {
  const result = await getAllUserLists()
  const serverUrl = getSession().serverUrl ?? ''
  const all = expandLists(result).map((list) => toListItem(list, serverUrl))

  const total = all.length
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const safePage = Math.min(Math.max(1, page), maxPage)
  const start = (safePage - 1) * PAGE_SIZE

  return {
    list: all.slice(start, start + PAGE_SIZE),
    total,
    page: safePage,
    limit: PAGE_SIZE,
    maxPage,
    key: `${sortId}__${tagId}__${safePage}`,
    source: 'anylisten',
    tagId,
    sortId,
  }
}

/**
 * 歌单内歌曲。
 *
 * ## 返回的为什么是「搜索项形状」而不是 `MusicInfo` 形状
 *
 * `core/songlist.ts:111` 对每一项再次调用 `toNewMusicInfo()`，而那个函数读的是
 * **旧版扁平对象**（`songmid` / `img` / `types` / `_types`），并且会无条件访问
 * `meta._qualitys.flac32bit` —— 若传给它一个已经转好的 `MusicInfo`，
 * 会在读 `_qualitys` 时抛异常，**每首歌都崩**。
 *
 * 所以这里与 `musicSearch.search` 保持一致，同样返回 `convertToSearchItem` 的结果：
 * 上游各商业源的 `getListDetail` 也是返回这种形状，由上层统一转换。
 * 这样 `meta.anylisten`（取播放地址所必需）会被 `toNewMusicInfo` 的
 * `case 'anylisten'` 分支原样带下去。
 *
 * 返回类型标成 `MusicInfoOnline[]` 是为了满足 `ListDetailInfo` 的声明，
 * 但**实际内容是待转换的搜索项**，转换由 `core/songlist.ts` 完成。
 */
export const getListDetail = async(id: string, page: number): Promise<ListDetailInfo> => {
  const serverUrl = getSession().serverUrl ?? ''
  const tracks = await loadTracks(id)

  const converted = tracks.map((t) => convertToSearchItem(t, serverUrl)) as unknown as LX.Music.MusicInfoOnline[]

  const total = converted.length
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const safePage = Math.min(Math.max(1, page), maxPage)
  const start = (safePage - 1) * PAGE_SIZE

  return {
    list: converted.slice(start, start + PAGE_SIZE),
    source: 'anylisten',
    total,
    page: safePage,
    limit: PAGE_SIZE,
    maxPage,
    key: `anylisten__${id}__${safePage}`,
    id,
    info: {
      name: `歌单（${total} 首）`,
      desc: '',
      author: '',
    },
  }
}

export default {
  sortList,
  getTags,
  getList,
  getListDetail,
}
