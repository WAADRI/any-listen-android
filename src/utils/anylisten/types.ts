/**
 * any-listen **服务端**的类型。
 *
 * 与 `src/types/music.d.ts` 里的 `LX.*` 是两套模型，刻意分开：
 * - `LX.Music.MusicInfo` 是 lx 的播放器模型（`meta.songId`、`meta.qualitys`…）
 * - 本文件的类型直接对应服务端返回的 JSON，只用于传输层与适配层
 *
 * 这里只声明**我们真正读写的字段**。服务端返回的对象还有 `createTime`、
 * `sizeStr`、`deviceId` 等一堆字段，它们不影响取址与展示，用索引签名放过即可。
 * 但要注意：传给 `getMusicUrl` 等接口时必须**原样回传整个对象**，
 * 不能只挑这里声明过的字段重建 —— 服务端的行为依赖那些未声明的字段
 * （见 `MusicInfoMeta_anylisten` 的注释）。
 */

/** 服务端曲目的元数据。字段名以实测返回为准。 */
export interface AnyListenMusicMeta {
  /** 歌曲 ID。本地曲目就是文件路径。 */
  musicId: string
  albumName?: string
  /** 封面地址。形如 `./api/p_static/<sha256>.jpeg`，是**同源相对路径**。 */
  picUrl?: string | null
  /** 本地曲目的文件路径 */
  filePath?: string
  ext?: string
  year?: number
  bitrateLabel?: string | null
  sizeStr?: string
  unparsed?: boolean
  createTime?: number
  updateTime?: number
  posTime?: number
  /** 只在 type: 'local' 的列表条目上出现 */
  deviceId?: string
  albumId?: string | number
  [key: string]: unknown
}

/**
 * 服务端的一首曲目。
 *
 * `isLocal` 很关键：服务端 `findMusic()` 用它决定走本地取址分支还是搜歌分支。
 * 丢掉它会让取址悄悄走到错误分支。
 */
export interface AnyListenMusicInfo {
  id: string
  name: string
  singer: string
  /** 时长，形如 "04:32" */
  interval: string | null
  isLocal?: boolean
  meta: AnyListenMusicMeta
  [key: string]: unknown
}

/** `getListMusics` 的返回：**裸数组**，不是信封对象。 */
export type AnyListenMusicList = AnyListenMusicInfo[]

/** 歌单元数据。服务端要求建歌单时**必须**提供它，否则报 NOT NULL constraint failed。 */
export interface AnyListenListMeta {
  songCount: number
  pic: string
  playCount: number
  createTime: number
  updateTime: number
  posTime: number
  desc: string
  [key: string]: unknown
}

/**
 * 歌单类型。
 *
 * 注意**不是** `'user'`（这是最容易猜错的值）。`'local'` 表示服务端主机上的
 * 文件夹映射，不是用户手建的歌单，应当只读。
 */
export type AnyListenListType = 'general' | 'local' | 'online' | 'remote'

export interface AnyListenUserList {
  id: string
  name: string
  type: AnyListenListType
  meta: AnyListenListMeta
  parentId: string | null
}

export interface AnyListenMyAllList {
  defaultList: AnyListenUserList
  loveList: AnyListenUserList
  lastPlayList: AnyListenUserList
  userList: AnyListenUserList[]
}

/** `getMusicUrl` 的返回。`url` 是虚拟地址，必须用 resolveServerUrl 解析。 */
export interface AnyListenMusicUrlInfo {
  url: string
  quality: string
  isFromCache: boolean
}

/** `getMusicPic` 的返回。 */
export interface AnyListenMusicPicInfo {
  url: string
  isFromCache: boolean
}

/** 服务端的歌词结构。`awlyric` 是逐字歌词，`tlyric` 是翻译。 */
export interface AnyListenLyricInfo {
  lyric: string
  tlyric?: string | null
  rlyric?: string | null
  /** 逐字歌词，形如 `[00:00.155]<0,359>从<359,220>前…` */
  awlyric?: string | null
  name?: string
  singer?: string
  interval?: string | null
}

export interface AnyListenMusicLyricResult {
  info: AnyListenLyricInfo
  isFromCache: boolean
}
