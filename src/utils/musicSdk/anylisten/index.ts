/**
 * any-listen 音源适配器。
 *
 * ## 这个文件是 lx 与 any-listen 的接缝，最容易出错的地方
 *
 * lx 的源层**没有显式接口**，契约只存在于调用点。而且三个资源方法的返回形状
 * **故意不一致**，这是移植时最容易静默失败的一处：
 *
 * | 方法 | 调用点 | 必须返回 |
 * |---|---|---|
 * | `getMusicUrl` | `core/music/utils.ts:304` | `{ promise, canceleFn }` —— 有 `.promise` |
 * | `getLyric` | `core/music/utils.ts:480` | `{ promise }` —— 有 `.promise` |
 * | `getPic` | `core/music/utils.ts:358` | **裸 Promise**，没有 `.promise` |
 *
 * 三个都写成 `async` 的话，`getMusicUrl` 与 `getLyric` 会在 `.promise` 处
 * 拿到 `undefined`，表现为不报错的播放/歌词失败。下面刻意按调用点的期望写。
 *
 * ## 取址必须用服务端原始对象
 *
 * 服务端 `getMusicUrl`/`getMusicPic`/`getMusicLyric` 内部走 `findMusic()`，
 * 依赖 `isLocal`、`meta.filePath` 等 lx 模型没有的字段。传重建的精简对象时
 * 服务端**返回 200 但结果是错的**（`./gdstudio-no-url`、别人的封面、`暂无歌词`）。
 * 所以这里一律用 `serverMusicInfoOf()` 取回原样保存的服务端对象，
 * 取不到就抛错，绝不退化成重建。
 */
// 注意路径层级：本文件在 src/utils/musicSdk/anylisten/，
// 而所有被引用的模块都在 src/utils/anylisten/ —— 是**上层目录**，
// 所以一律用 ../../anylisten/ 前缀。
import { getMusicUrl, getMusicPic, getMusicLyric, ensureConnected } from '../../anylisten/api'
import { resolveServerUrl } from '../../anylisten/serverUrl'
import { ensureLoaded, searchLibrary, getLibraryState } from '../../anylisten/library'
import { serverMusicInfoOf } from '../../anylisten/convert'
import type { AnyListenMusicInfo } from '../../anylisten/types'
// 必须在这里 import 一次并作为值导出。
// 只写 `export { default as songList } from './songList'` 是**纯再导出**，
// 它不会在当前模块里绑定 `songList` 标识符，下面默认导出里引用它会直接
// ReferenceError（而打包阶段发现不了）。
import songList from './songList'

/**
 * 服务端在「无法真正取到媒体」时会返回这个占位地址。
 *
 * 实测：传入缺少 `isLocal`/`meta.filePath` 的曲目对象时，`getMusicUrl`
 * 返回 `{ url: './gdstudio-no-url', quality: '128k', isFromCache: false }` ——
 * **HTTP 200、结构完整、不报错**，但播放器拿到的地址播不出任何声音。
 *
 * 服务端的 `allowedUrl` 正则 `^(?:https?:\/\/\S+|(?:\.{0,2})\/(?!\/)\S*)$`
 * 会放行 `./gdstudio-no-url`，所以服务端不会把它当成错误。
 * 客户端必须自己识别，否则表现就是「进度条在走但没有声音」。
 */
const PLACEHOLDER_URL_MARKER = 'gdstudio-no-url'

/** 判定服务端返回的地址是否是「播不出声」的占位值。 */
export function isPlaceholderUrl(url: string): boolean {
  return url.includes(PLACEHOLDER_URL_MARKER)
}

/** 当前服务器地址，用于把虚拟地址解析成绝对地址。 */
let serverUrlProvider: (() => string) | null = null

export function setupSource(options: { getServerUrl: () => string }): void {
  serverUrlProvider = options.getServerUrl
}

function serverUrl(): string {
  try {
    return serverUrlProvider?.() ?? ''
  } catch {
    return ''
  }
}

/**
 * 从 lx 传进来的「旧版扁平对象」里取回服务端原始曲目。
 *
 * 逻辑委托给 `serverMusicInfoOf`，与适配层共用同一处判断与同一个错误类型 ——
 * 重复实现会让两边的行为在某次改动后悄悄分叉。
 */
function rawOf(oldMusicInfo: any): AnyListenMusicInfo {
  // 这里**不能**用 oldMusicInfo 的字段重建曲目：
  // 服务端会返回 200 但给出错误结果，且不会有任何报错。
  return serverMusicInfoOf(oldMusicInfo)
}

/**
 * 取播放地址。返回 `{ promise, canceleFn }` —— 注意有 `.promise`。
 */
export function fetchMusicUrl(oldMusicInfo: any, quality?: LX.Quality) {
  const promise = (async(): Promise<{ type: LX.Quality, url: string }> => {
    const raw = rawOf(oldMusicInfo)
    const result = await getMusicUrl(raw)

    if (!result?.url) throw new Error('服务端没有返回播放地址')
    if (isPlaceholderUrl(result.url)) {
      throw new Error('服务端没有可用的播放地址（返回了占位值），该曲目可能已从曲库移除')
    }

    const resolved = resolveServerUrl(result.url, serverUrl())
    if (!resolved) throw new Error(`无法解析服务端返回的播放地址：${result.url}`)

    // 服务端给什么音质就用什么音质，不要报告一个它没提供的档位
    const type = (typeof result.quality === 'string' && result.quality
      ? result.quality
      : quality ?? '128k') as LX.Quality

    return { type, url: resolved }
  })()

  return {
    promise,
    // lx 会在切歌时调用它中止上一次请求。这里的请求是短连接且已由会话层管理超时，
    // 没有可中止的句柄，所以是空实现（内置源在无代理时也是这么做的）。
    canceleFn: () => {},
  }
}

/**
 * 取封面。返回**裸 Promise**（没有 `.promise`）—— 与上面两个刻意不同。
 */
export function fetchPic(oldMusicInfo: any): Promise<string> {
  return (async(): Promise<string> => {
    const raw = rawOf(oldMusicInfo)

    // 优先用服务端直接给的封面地址，避免多打一次请求
    const inline = resolveServerUrl(raw.meta?.picUrl, serverUrl())
    if (inline) return inline

    const result = await getMusicPic(raw)
    if (!result?.url) throw new Error('服务端没有返回封面地址')
    const resolved = resolveServerUrl(result.url, serverUrl())
    if (!resolved) throw new Error(`无法解析服务端返回的封面地址：${result.url}`)
    return resolved
  })()
}

/**
 * 取歌词。返回 `{ promise }` —— 注意有 `.promise`。
 *
 * ⚠️ lx 在 `core/music/utils.ts:485` 用 `existTimeExp = /\[\d{1,2}:.*\d{1,4}\]/`
 * 检验歌词正文。**正文里没有任何 `[mm:ss]` 时间戳就会被当成失败丢掉**，
 * 表现为歌词页空白且**没有任何日志**。
 *
 * 好消息：实测本项目的服务端返回的 `lyric` 就是带时间戳的正常 LRC
 * （`[00:00.155]从前 - 王俊凯`），`awlyric` 是逐字格式
 * （`[00:00.155]<0,359>从<359,220>前…`）。因此直接透传即可，
 * 不需要像某些部署形态那样从 `[awlrc:...]` 标签里做 base64 解码。
 */
export function fetchLyric(oldMusicInfo: any) {
  const promise = (async(): Promise<LX.Music.LyricInfo> => {
    const raw = rawOf(oldMusicInfo)
    const result = await getMusicLyric(raw)
    const info = result?.info
    if (!info) throw new Error('服务端没有返回歌词')

    const lyric = typeof info.lyric === 'string' ? info.lyric : ''
    if (!lyric) throw new Error('服务端返回了空歌词')

    /**
     * 诊断：歌词取到了什么。
     *
     * 歌词整条链路的失败**全是静默的**：`core/music/utils.ts` 的时间戳校验
     * 失败只会 `console.log(err)`（手机上看不到），`buildLyricInfo` 也不报错，
     * 界面最后就是一片空白。所以这里把关键事实打出来：长度、是否带时间戳、
     * 首行内容。有了它就能区分「服务端没给」「格式不对」「链路丢了」。
     */
    const hasTimestamp = /\[\d{1,2}:\d{2}/.test(lyric)
    console.log(
      `[anylisten] 歌词诊断：${raw.name ?? '?'} 长度=${lyric.length}`
      + ` 带时间戳=${hasTimestamp} 首行=${JSON.stringify((lyric.split('\n')[0] ?? '').slice(0, 40))}`,
    )

    return {
      lyric,
      tlyric: typeof info.tlyric === 'string' && info.tlyric ? info.tlyric : null,
      rlyric: typeof info.rlyric === 'string' && info.rlyric ? info.rlyric : null,
      // 逐字歌词
      lxlyric: typeof info.awlyric === 'string' && info.awlyric ? info.awlyric : null,
    }
  })()

  return { promise }
}

/**
 * 搜索。
 *
 * any-listen 没有服务端搜索接口，只有「列歌单 / 列歌单内歌曲」，
 * 因此在**本机**对已拉取的曲库做匹配（见 `library.ts`）。
 * 第一次搜索会触发一次全量拉取。
 */
export const musicSearch = {
  search: async(text: string, page = 1, limit = 30) => {
    await ensureLoaded()
    const status = getLibraryState().status
    if (status === 'error') {
      // 让错误上抛：静默返回空结果会让用户以为「搜不到」而不是「连不上」
      throw new Error(getLibraryState().error ?? '曲库加载失败')
    }
    return searchLibrary(text, page, limit)
  },
}

/**
 * 初始化。**必须成功 resolve** ——
 * `handleGetOnlineMusicUrl` 开头有 `if (!await global.lx.apiInitPromise[0]) throw new Error('source init failed')`，
 * 这里 reject 会让所有播放直接失败。
 */
export const init = async(): Promise<void> => {
  await ensureConnected()
}

/** 音质声明。缺了它 `assertApiSupport` 会返回 false，音源会被整体跳过。 */
export const supportQualitys: LX.Quality[] = ['128k']

/**
 * 歌单浏览界面（歌单广场 + 歌单详情）的数据源。
 *
 * `core/songlist.ts` 只用到它的 `getTags` / `getList` / `getListDetail` 三个方法，
 * 因此实现这三个方法就能让**整个现成的歌单界面**工作，包括
 * 「播放全部」「下载」「批量操作」等，不需要改界面代码。
 */
export { songList }

/**
 * 歌曲在网页端的详情页地址。
 *
 * ## 为什么必须存在（哪怕返回空串）
 *
 * `utils/tools.ts` 的 `shareMusic` 是这么写的：
 *
 * ```js
 * musicSdk[musicInfo.source]?.getMusicDetailPageUrl(...) ?? ''
 * ```
 *
 * `?.` 只保住了 `musicSdk[source]` 本身，**保不住方法**。对象存在但没有这个方法时，
 * 它变成 `undefined(...)`，直接抛 `TypeError: undefined is not a function` ——
 * 表现就是**一点「分享」就报错**（日志栈里 `shareMusic` → `handleShare`）。
 *
 * any-listen 是自建服务，没有公开的歌曲网页，所以如实返回空串：
 * 分享内容里就不带链接，而不是崩掉。
 */
export function getMusicDetailPageUrl(): string {
  return ''
}

export default {
  init,
  musicSearch,
  songList,
  getMusicUrl: fetchMusicUrl,
  getPic: fetchPic,
  getLyric: fetchLyric,
  getMusicDetailPageUrl,
  // 不提供 leaderboard / hotSearch / comment：any-listen 没有对应的服务端能力。
  //
  // ⚠️ 但这些入口的调用点未必都做了防御。已知 `shareMusic` 用 `?.` 只保住了
  // 对象、没保住方法，缺一个方法就会 `TypeError`。新增能力时请一并检查调用点，
  // 不要假设「不实现就等于自动禁用」。
}
