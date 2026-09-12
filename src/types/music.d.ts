declare namespace LX {
  namespace Music {
    /**
     * any-listen 服务端返回的原始曲目对象。
     *
     * 用 `import(...)` 内联引用而不是把服务端类型塞进本文件：两者是不同模型，
     * 混在一起会让「该信哪个字段」变得含糊。
     */
    type AnyListenRawMusicInfo = import('@/utils/anylisten/types').AnyListenMusicInfo

    interface MusicQualityType { // {"type": "128k", size: "3.56M"}
      type: LX.Quality
      size: string | null
    }
    interface MusicQualityTypeKg { // {"type": "128k", size: "3.56M"}
      type: LX.Quality
      size: string | null
      hash: string
    }
    type _MusicQualityType = Partial<Record<Quality, {
      size: string | null
    }>>
    type _MusicQualityTypeKg = Partial<Record<Quality, {
      size: string | null
      hash: string
    }>>


    interface MusicInfoMetaBase {
      songId: string | number // 歌曲ID，mg源为copyrightId，local为文件路径
      albumName: string // 歌曲专辑名称
      picUrl?: string | null // 歌曲图片链接
      toggleMusicInfo?: MusicInfoOnline | null
    }

    interface MusicInfoMeta_online extends MusicInfoMetaBase {
      qualitys: MusicQualityType[]
      _qualitys: _MusicQualityType
      albumId?: string | number // 歌曲专辑ID
    }

    interface MusicInfoMeta_local extends MusicInfoMetaBase {
      filePath: string
      ext: string
    }


    interface MusicInfoBase<S = LX.Source> {
      id: string
      name: string // 歌曲名
      singer: string // 艺术家名
      source: S // 源
      interval: string | null // 格式化后的歌曲时长，例：03:55
      meta: MusicInfoMetaBase
    }

    interface MusicInfoLocal extends MusicInfoBase<'local'> {
      meta: MusicInfoMeta_local
    }

    interface MusicInfo_online_common extends MusicInfoBase<'kw' | 'wy'> {
      meta: MusicInfoMeta_online
    }

    interface MusicInfoMeta_kg extends MusicInfoMeta_online {
      qualitys: MusicQualityTypeKg[]
      _qualitys: _MusicQualityTypeKg
      hash: string // 歌曲hash
    }
    interface MusicInfo_kg extends MusicInfoBase<'kg'> {
      meta: MusicInfoMeta_kg
    }

    interface MusicInfoMeta_tx extends MusicInfoMeta_online {
      strMediaMid: string // 歌曲strMediaMid
      id?: number // 歌曲songId
      albumMid?: string // 歌曲albumMid
    }
    interface MusicInfo_tx extends MusicInfoBase<'tx'> {
      meta: MusicInfoMeta_tx
    }

    interface MusicInfoMeta_mg extends MusicInfoMeta_online {
      copyrightId: string // 歌曲copyrightId
      lrcUrl?: string // 歌曲lrcUrl
      mrcUrl?: string // 歌曲mrcUrl
      trcUrl?: string // 歌曲trcUrl
    }
    interface MusicInfo_mg extends MusicInfoBase<'mg'> {
      meta: MusicInfoMeta_mg
    }

    /**
     * 服务端曲目在 lx 模型里的投影。
     *
     * 除了质量字段，这里**额外保存了一份服务端原始对象** `anylisten`。
     *
     * 为什么必须保存：服务端的 `getMusicUrl` / `getMusicPic` / `getMusicLyric`
     * 内部走的是 `findMusic()`，它对 `isLocal` / `meta.filePath` 等字段有依赖。
     * 实测（tools/ws-probe-musicinfo.mjs、tools/ws-probe-pic-lyric.mjs）表明，
     * 传一个「只有 id/name/singer」的精简对象时服务端**照样返回 200**，但结果是错的：
     *
     * | 接口 | 完整对象 | 精简对象 |
     * |---|---|---|
     * | getMusicUrl | 真实 mp3 地址 | `./gdstudio-no-url`（播不出声） |
     * | getMusicPic | 本地封面 | 网易云的封面（错误的图） |
     * | getMusicLyric | 真实歌词 | `[00:00.00]暂无歌词` |
     *
     * 三种失败都不报错，只表现为「没声音 / 封面不对 / 没歌词」，
     * 所以这里保留原始对象作为唯一可靠依据，而不是从 lx 字段反推。
     */
    interface MusicInfoMeta_anylisten extends MusicInfoMeta_online {
      source: 'anylisten'
      /** 服务端返回的原始曲目对象，用于回传给 getMusicUrl / getMusicPic / getMusicLyric */
      anylisten?: AnyListenRawMusicInfo
      /** 服务端标记的本地文件（isLocal），findMusic 依赖它选择取址分支 */
      anylistenIsLocal?: boolean
      /** 服务端侧的文件路径，本地曲目取址时需要 */
      anylistenFilePath?: string
    }
    interface MusicInfo_anylisten extends MusicInfoBase<'anylisten'> {
      meta: MusicInfoMeta_anylisten
    }

    type MusicInfoOnline =
      | MusicInfo_online_common
      | MusicInfo_kg
      | MusicInfo_tx
      | MusicInfo_mg
      | MusicInfo_anylisten
    type MusicInfo = MusicInfoOnline | MusicInfoLocal

    interface LyricInfo {
      // 歌曲歌词
      lyric: string
      // 翻译歌词
      tlyric?: string | null
      // 罗马音歌词
      rlyric?: string | null
      // 逐字歌词
      lxlyric?: string | null
    }

    interface LyricInfoSave {
      id: string
      lyrics: LyricInfo
    }

    interface MusicUrlInfo {
      id: string
      url: string
    }

    interface MusicInfoOtherSourceSave {
      id: string
      list: MusicInfoOnline[]
    }

  }
}
