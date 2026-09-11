/**
 * 服务端曲目 ⇄ lx 播放器模型 的转换。
 *
 * ## 为什么必须保留服务端原始对象
 *
 * 服务端的 `getMusicUrl` / `getMusicPic` / `getMusicLyric` 内部都走 `findMusic()`，
 * 而 `findMusic` 依赖 `isLocal`、`meta.filePath`、`meta.fileName` 等字段来选择取址分支。
 * 实测（`tools/ws-probe-musicinfo.mjs`、`tools/ws-probe-pic-lyric.mjs`）表明：
 * 传一个从 lx 字段**反推重建**的精简对象时，服务端**照样返回 200**，但结果是错的 ——
 *
 * | 接口 | 完整对象 | 精简对象（不报错） |
 * |---|---|---|
 * | getMusicUrl | 真实 mp3 地址 | `./gdstudio-no-url`，播不出声 |
 * | getMusicPic | 本机封面 | 网易云的封面，图是错的 |
 * | getMusicLyric | 真实歌词 | `[00:00.00]暂无歌词` |
 *
 * 三种失败都没有任何错误日志，只表现为「没声音 / 封面不对 / 没歌词」。
 * 因此这里的做法是：把服务端对象**原样**挂在 `meta.anylisten` 上带走，
 * 需要时原样回传，而不是重建。
 *
 * `listManage` 持久化的是完整 `MusicInfo`，所以 `meta.anylisten` 能跨重启存活。
 */
import type { AnyListenMusicInfo } from './types'
import { resolveServerUrl } from './serverUrl'

/**
 * 取服务器地址，用于把服务端返回的相对/虚拟地址解析成绝对地址。
 *
 * 注入而不是 import `api.ts`：`api.ts` 会把整个设置 store 拖进来，
 * 而本模块需要能在 Node 下单测。
 */
let serverUrlProvider: (() => string) | null = null

export function setupConvert(options: { getServerUrl: () => string }): void {
  serverUrlProvider = options.getServerUrl
}

function currentServerUrl(override?: string): string {
  if (override != null) return override
  try {
    return serverUrlProvider?.() ?? ''
  } catch {
    return ''
  }
}

/**
 * lx 侧每次取址都需要这个曲目必须携带服务端原始对象。
 *
 * 缺失时**不能**退回「重建一个精简对象」——那会静默返回错地址。
 * 所以这里明确抛错，让问题以可见的方式暴露出来。
 */
export class MissingServerMusicInfoError extends Error {
  constructor(id: string) {
    super(
      `曲目缺少服务端原始对象（id=${id}）。` +
      '没有它就无法正确取址：服务端会返回 HTTP 200 但给出无效的播放地址。' +
      '请重新从服务端加载该歌单以补全数据。',
    )
    this.name = 'MissingServerMusicInfoError'
  }
}

/** 从 lx 模型里取回服务端原始对象。取不到时抛错，绝不静默重建。 */
export function serverMusicInfoOf(musicInfo: LX.Music.MusicInfo): AnyListenMusicInfo {
  const raw = (musicInfo.meta as LX.Music.MusicInfoMeta_anylisten | undefined)?.anylisten
  if (!raw?.meta?.musicId && !raw?.id) {
    throw new MissingServerMusicInfoError(musicInfo.id)
  }
  return raw
}

/** 服务端返回的质量标识归一化到 lx 的 Quality。 */
function toLxQuality(quality: unknown): LX.Quality {
  const known: LX.Quality[] = ['128k', '320k', 'flac', 'flac24bit', '192k', 'ape', 'wav']
  const q = typeof quality === 'string' ? quality.toLowerCase() : ''
  const hit = known.find((k) => k === q)
  return hit ?? '128k'
}

/**
 * 服务端曲目 → lx 播放器模型。
 *
 * 注意 `id`：直接用服务端自己的 `id`（本地曲目就是文件路径，稳定且唯一）。
 * 不能沿用内置源 `source_${songmid}` 的拼法 —— 服务端 id 里可能含 `/` 和空格，
 * 拼出来既难读又容易在按 id 比较的地方出错。
 */
export function toLxMusicInfo(track: AnyListenMusicInfo, serverUrlOverride?: string): LX.Music.MusicInfoOnline {
  const interval = typeof track.interval === 'string' && track.interval ? track.interval : null

  // 封面地址必须**在这里**就解析成绝对地址。
  //
  // 原因：`handleGetOnlinePicUrl` 在调 `getPic` 之前有一句短路 ——
  //   if (musicInfo.meta.picUrl && !isRefresh) return { url: musicInfo.meta.picUrl, ... }
  // 也就是说只要 meta.picUrl 有值就不会走 getPic。若这里保留服务端原始的
  // `./api/p_static/<sha>.jpeg`，封面会以「同源相对路径」直接交给图片层
  // （历史上正是 FileNotFoundException）。因此解析必须发生在此处，
  // 而不是指望每个消费点都记得解析。
  const picUrl = resolveServerUrl(track.meta?.picUrl, currentServerUrl(serverUrlOverride))

  // 质量：服务端实测只给 128k。按实际能力声明，避免 UI 显示不存在的高音质档位。
  const quality: LX.Quality = '128k'
  const size = track.meta?.sizeStr ?? null
  const qualitys: LX.Music.MusicQualityType[] = [{ type: quality, size }]
  const _qualitys: LX.Music._MusicQualityType = { [quality]: { size } }

  const meta: LX.Music.MusicInfoMeta_anylisten = {
    // songId 用服务端 musicId（服务端侧真正的歌曲标识）
    songId: track.meta?.musicId ?? track.id,
    albumName: track.meta?.albumName ?? '',
    picUrl,
    qualitys,
    _qualitys,
    source: 'anylisten',
    // 原样保留，取址时靠它
    anylisten: track,
    anylistenIsLocal: track.isLocal === true,
    anylistenFilePath: track.meta?.filePath,
  }

  return {
    id: track.id,
    name: track.name,
    singer: track.singer,
    source: 'anylisten',
    interval,
    meta,
  }
}

/**
 * lx 播放器模型 → 「旧版」扁平对象。
 *
 * lx 内部的搜索结果、切源、`findMusic` 兜底都经过 `toNewMusicInfo(oldMusicInfo)`，
 * 因此这里必须把 `anylisten` 一起带上，否则转换后就丢了原始对象
 * （见 `src/utils/index.ts` 里 `toNewMusicInfo` 的 anylisten 分支）。
 */
export function toOldMusicInfoFromLx(musicInfo: LX.Music.MusicInfoOnline): Record<string, unknown> {
  const meta = musicInfo.meta as LX.Music.MusicInfoMeta_anylisten
  return {
    name: musicInfo.name,
    singer: musicInfo.singer,
    source: 'anylisten',
    songmid: meta.songId,
    interval: musicInfo.interval,
    albumName: meta.albumName,
    img: meta.picUrl ?? '',
    types: meta.qualitys,
    _types: meta._qualitys,
    typeUrl: {},
    // 关键：带上服务端原始对象，供 toNewMusicInfo 重建时保留
    anylisten: meta.anylisten,
  }
}

/** 批量转换，并过滤掉服务端返回里的空条目。 */
export function toLxMusicList(tracks: unknown, serverUrlOverride?: string): LX.Music.MusicInfoOnline[] {
  if (!Array.isArray(tracks)) return []
  return tracks
    .filter((t): t is AnyListenMusicInfo =>
      !!t && typeof t === 'object' && typeof (t as AnyListenMusicInfo).id === 'string')
    .map((t) => toLxMusicInfo(t, serverUrlOverride))
}

/**
 * 服务端曲目 → 搜索结果的「旧版扁平对象」。
 *
 * lx 的搜索链路（`store/search/music/action.ts`）会对每一项调用
 * `toNewMusicInfo()`，所以这里也必须带上 `anylisten`，否则搜索结果加进歌单后
 * 就丢了服务端原始对象，播放时会取不到正确地址。
 *
 * `types` / `_types` 是 `toNewMusicInfo` 读取的字段名（不是 `qualitys`），
 * 缺失会让它写出 `undefined`，进而让音质判断出问题。
 */
export function convertToSearchItem(track: AnyListenMusicInfo, serverUrlOverride?: string): Record<string, unknown> {
  const size = track.meta?.sizeStr ?? null
  const quality: LX.Quality = '128k'
  return {
    name: track.name,
    singer: track.singer,
    source: 'anylisten',
    songmid: track.meta?.musicId ?? track.id,
    interval: track.interval,
    albumName: track.meta?.albumName ?? '',
    // 同样要解析：这个值会被 toNewMusicInfo 写进 meta.picUrl，
    // 而 meta.picUrl 有值时封面走的短路分支不会再解析。
    img: resolveServerUrl(track.meta?.picUrl, currentServerUrl(serverUrlOverride)) ?? '',
    types: [{ type: quality, size }],
    _types: { [quality]: { size } },
    typeUrl: {},
    anylisten: track,
  }
}
