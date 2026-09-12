/**
 * any-listen 的歌单界面数据源。
 *
 * ## 为什么实现这个接口而不是重写界面
 *
 * lx 的歌单浏览界面（歌单广场 + 歌单详情，含「播放全部」「下载」「批量操作」）
 * 全部通过 lx 的**源层 `songList` 接口**取数据，而 `core/songlist.ts` 只用到其中
 * **三个方法**，搜索页另用第四个：
 *
 * | 方法 | 调用点 | 作用 |
 * |---|---|---|
 * | `getTags()` | `core/songlist.ts:31` | 分类标签 |
 * | `getList(sortId, tagId, page)` | `core/songlist.ts:80` | 歌单列表 |
 * | `getListDetail(id, page)` | `core/songlist.ts:109` | 歌单内歌曲 |
 * | `search(text, page, limit)` | `core/search/songlist.ts` | 搜索页的「歌单」标签页 |
 *
 * 因此只要这四个方法按契约返回，**整个歌单界面不需要改一行代码**就能用。
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
import { getAllUserLists, getListCover, getListMusics, getSession } from '../../anylisten/api'
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
 * `meta` 的真实键是
 * `deviceId / path / includeSubDir / lazzyParseMeta / createTime / updateTime /
 * desc / playCount / posTime / enabledRemove / songCount`：
 *
 * - **没有 `author`**：没有创建者概念。留空字符串，不要编造。
 * - **没有 `time`**：没有创建时间字符串。界面用 `total` 显示歌曲数代替。
 * - **没有封面**：封面由 `getListCover(listId)` 单独取（见 `fetchCover`），
 *   以参数传入本函数。
 *
 * 这些字段是「有则有、无则空」，所以不能用 `?? ''` 之外的默认值去填，
 * 那样会显示假信息。
 */
function toListItem(list: AnyListenUserList, coverUrl: string): ListInfoItem {
  // 封面**不在** list.meta 里，必须由 getListCover 取（见下面的 fetchCovers）。
  return {
    id: list.id,
    name: list.name || '未命名歌单',
    author: list.meta?.path ?? '',
    img: coverUrl,
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
 * 歌单封面的缓存与并发去重。
 *
 * 两个必要性：
 *
 * 1. **封面是逐歌单一次 RPC**（服务端 `getListCover` 内部还要读该歌单第一首歌
 *    再取图），翻页/重建界面时不该重复请求；
 * 2. 同一个歌单在并发请求里要复用**同一个 promise**，否则 27 个歌单会发两轮。
 *
 * 之前我以为服务端不提供歌单封面 —— 那是错的：`list.meta` 里确实没有
 * pic/img/cover 字段，但服务端有专门的 `getListCover`，它用「歌单第一首歌的
 * 封面」算出来。只查 meta 的键就下结论，导致这里一直是空占位。
 */
const coverCache = new Map<string, Promise<string>>()

function fetchCover(listId: string, serverUrl: string): Promise<string> {
  const key = `${serverUrl}\u0000${listId}`
  const hit = coverCache.get(key)
  if (hit) return hit

  const task = getListCover(listId)
    .then((cover) => {
      const resolved = resolveServerUrl(cover, serverUrl) ?? ''
      // 只在**解析不出来**时记录：服务端返回 null 表示空歌单（正常），
      // 解析出空串才是真的有问题（曾经整条封面链路"看起来实现了却什么都没有"，
      // 靠这个信号才定位到 `serverUrl` 取不到值）。成功路径不再打日志：
      // 每次刷新歌单都会刷出几十行，把真正有用的日志淹掉。
      if (!resolved && cover != null) {
        console.warn(`[anylisten] 歌单封面 ${listId} 解析失败：${cover}`)
      }
      return resolved
    })
    .catch((err: unknown) => {
      console.warn(`[anylisten] 歌单封面 ${listId} 获取失败：${err instanceof Error ? err.message : String(err)}`)
      return ''
    })
  coverCache.set(key, task)
  return task
}

/** 切换服务器后必须丢弃封面缓存，否则会把旧服务器的封面当成新的。 */
export const clearSongListCache = () => {
  detailCache.clear()
  coverCache.clear()
  nameCache.clear()
}

/**
 * 歌单名缓存。
 *
 * `getListDetail(id, page)` **只拿得到 id**（签名里没有名字），但详情页要显示
 * 歌单名。早先这里写死成 `歌单（N 首）`，于是收藏到「我的列表」后名字就变成
 * 那个样子 —— 那不是歌单名，只是占位文案。
 *
 * 所以 `getList` 拿到名字时记下来，`getListDetail` 按 id 取回。
 */
const nameCache = new Map<string, string>()

function rememberListNames(lists: AnyListenUserList[], serverUrl: string): void {
  for (const list of lists) {
    if (list.name) nameCache.set(`${serverUrl}\u0000${list.id}`, list.name)
  }
}

/**
 * 详情页拿不到名字时的兜底：重新拉一次歌单列表来查。
 * 正常路径（先经过歌单页）不会走到这里。
 */
async function findListName(listId: string, serverUrl: string): Promise<string | undefined> {
  const key = `${serverUrl}\u0000${listId}`
  const hit = nameCache.get(key)
  if (hit) return hit
  try {
    const all = await getAllUserLists()
    rememberListNames(expandLists(all), serverUrl)
    return nameCache.get(key)
  } catch {
    return undefined
  }
}

/**
 * 取出要展示的歌单。
 *
 * `getAllUserLists` 返回的是 `{ defaultList, loveList, lastPlayList, userList }`
 * —— **不是数组**。（一开始按 `result.list` 读，那永远是空的。）
 *
 * ## 只取 `userList`
 *
 * `defaultList` / `loveList` / `lastPlayList` 是服务端的内置列表，不是用户
 * 建来浏览的歌单，混进歌单页只会让人困惑。实测它们的内容也是空的
 * （`defaultList`、`loveList` 都没有歌），而真正的曲库在 `userList` 里 ——
 * 包括 `type: 'local'` 的「全部歌曲」（该服务器上 1653 首，来自挂载的 /music）。
 *
 * 因此这里**不再**用 `meta.enabledRemove` 过滤：那个标记区分的是「能否被用户
 * 删除」，而「全部歌曲」虽然不可删除，却正是用户最想点进去播放的歌单。
 * 用 `enabledRemove` 过滤会把它连同文件夹映射一起排除掉。
 */
function expandLists(all: AnyListenMyAllList | undefined | null): AnyListenUserList[] {
  if (!all) return []
  const users = Array.isArray(all.userList) ? all.userList : []
  return users.filter((list): list is AnyListenUserList =>
    !!list && typeof list.id === 'string',
  )
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
 *
 * 封面需要**逐歌单一次 RPC**，所以只为当前这一页的歌单取（其余页不浪费请求），
 * 并且并行发起 —— 串行的话 27 个歌单会让首屏明显变慢。
 */
export const getList = async(sortId: string, tagId: string, page: number): Promise<ListInfo> => {
  const result = await getAllUserLists()
  const serverUrl = getSession().serverUrl ?? ''
  const lists = expandLists(result)

  const total = lists.length
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const safePage = Math.min(Math.max(1, page), maxPage)
  const start = (safePage - 1) * PAGE_SIZE
  const pageLists = lists.slice(start, start + PAGE_SIZE)

  // 记下名字，供详情页使用（详情页签名里没有名字）
  rememberListNames(lists, serverUrl)

  // 并行取这一页的封面；单个失败不影响整个列表（fetchCover 内部已兜成空串）
  const covers = await Promise.all(pageLists.map((list) => fetchCover(list.id, serverUrl)))

  return {
    list: pageLists.map((list, i) => toListItem(list, covers[i])),
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

  // 详情页头部的封面也走 getListCover（与列表格同一份缓存，不会重复请求）
  const cover = await fetchCover(id, serverUrl)
  // 歌单名：签名里没有，靠 getList 时记下的缓存（必要时兜底重拉一次）
  const name = await findListName(id, serverUrl)

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
      // 用真实歌单名。之前写死成「歌单（N 首）」，收藏后会把这个占位文案
      // 当成歌单名显示在「我的列表」里。
      name: name ?? `歌单（${total} 首）`,
      img: cover,
      desc: '',
      author: '',
    },
  }
}

/**
 * 歌单搜索（搜索页的「歌单」标签页）。
 *
 * ## 为什么必须存在
 *
 * `core/search/songlist.ts:30` 写的是 `musicSdk[source]?.songList.search(...)`
 * —— `?.` 只保住了 `musicSdk[source]`，**保不住 `.search`**。本适配器原先没有
 * 这个方法，于是「歌单」标签页一搜就抛 `TypeError: undefined is not a function`；
 * 更糟的是 `store/search/songlist/state.ts:46` 会用
 * `music[source.id]?.songList?.search` 判断「这个源支不支持歌单搜索」，
 * 缺了它连源列表都是空的。
 *
 * ## 语义
 *
 * 商业源的歌单搜索是「在平台的歌单广场里按关键词找歌单」；这里是
 * **在用户自己的歌单里按名字找**（曲库里的歌单就是用户自己的）。
 *
 * 返回形状与商业源一致：`{ list, total, limit, source }` ——
 * `store/search/songlist/action.ts` 的 `setList()` 用 `datas.source` 取列表信息，
 * 少了它会和歌曲搜索一样在 `undefined` 上取属性。
 */
export const search = async(text: string, page = 1, limit = PAGE_SIZE): Promise<{
  list: ListInfoItem[]
  total: number
  limit: number
  source: 'anylisten'
}> => {
  const all = await getAllUserLists()
  const serverUrl = getSession().serverUrl ?? ''
  const lists = expandLists(all)
  // 顺带记下名字，歌单详情页要靠它显示真实歌单名
  rememberListNames(lists, serverUrl)

  const q = (text ?? '').trim().toLowerCase()
  const matched = q
    ? lists.filter(list => (list.name ?? '').toLowerCase().includes(q))
    : lists

  const safePage = Math.max(1, page)
  const start = (safePage - 1) * limit
  const pageLists = matched.slice(start, start + limit)
  const covers = await Promise.all(pageLists.map(list => fetchCover(list.id, serverUrl)))

  return {
    list: pageLists.map((list, i) => toListItem(list, covers[i])),
    total: matched.length,
    limit,
    source: 'anylisten',
  }
}

export default {
  sortList,
  getTags,
  getList,
  getListDetail,
  search,
}
