import playerActions from '@/store/player/action'
import playerState from '@/store/player/state'

import { getListMusicSync } from '@/utils/listManage'
import { setProgress } from '@/core/player/progress'
import { LIST_IDS } from '@/config/constant'
import { toOldMusicInfo } from '@/utils'
import { serverMusicInfoOf } from '@/utils/anylisten/convert'
import { resolveServerUrl } from '@/utils/anylisten/serverUrl'
import { getMusicPic, getSession } from '@/utils/anylisten/api'
import { updateListMusics } from '@/core/list'


export const setMusicInfo = (musicInfo: Partial<LX.Player.MusicInfo>) => {
  playerActions.setMusicInfo(musicInfo)
}

export const setLoadErrorPicUrl = (url: string) => {
  playerActions.setLoadErrorPicUrl(url)
}

export const setLastLyric = (lrc?: string) => {
  playerActions.setLastLyric(lrc)
}

export const setPlayListId = (listId: string | null) => {
  playerActions.setPlayListId(listId)
}


/**
 * 更新播放位置
 * @returns 播放位置
 */
export const updatePlayIndex = () => {
  const indexInfo = getPlayIndex(playerState.playMusicInfo.listId, playerState.playMusicInfo.musicInfo, playerState.playMusicInfo.isTempPlay)
  // console.log('indexInfo', indexInfo)
  playerActions.updatePlayIndex(indexInfo.playIndex, indexInfo.playerPlayIndex)
  return indexInfo
}


export const getPlayIndex = (listId: string | null, musicInfo: LX.Download.ListItem | LX.Music.MusicInfo | null, isTempPlay: boolean): {
  playIndex: number
  playerPlayIndex: number
} => {
  const { playInfo } = playerState
  const playerList = getListMusicSync(playInfo.playerListId)

  // if (listIndex < 0) throw new Error('music info not found')
  // playInfo.playIndex = listIndex

  let playIndex = -1
  let playerPlayIndex = -1
  if (playerList.length) {
    playerPlayIndex = Math.min(playInfo.playerPlayIndex, playerList.length - 1)
  }

  const list = getListMusicSync(listId)
  if (list.length && musicInfo) {
    const currentId = musicInfo.id
    playIndex = list.findIndex(m => m.id == currentId)
    if (!isTempPlay) {
      if (playIndex < 0) {
        playerPlayIndex = playerPlayIndex < 1 ? (list.length - 1) : (playerPlayIndex - 1)
      } else {
        playerPlayIndex = playIndex
      }
    }
  }

  return {
    playIndex,
    playerPlayIndex,
  }
}

export const resetPlayerMusicInfo = () => {
  setMusicInfo({
    id: null,
    pic: null,
    lrc: null,
    tlrc: null,
    rlrc: null,
    lxlrc: null,
    rawlrc: null,
    name: '',
    singer: '',
    album: '',
  })
}

let lastPicRefreshId = ''

/**
 * anylisten 的封面地址会随服务端缓存清理而失效（本地列表里存的是收藏/添加时的快照），
 * 而 UI 的封面直接用 `meta.picUrl` 快照显示、没有任何重取机制——服务端清一次缓存，
 * 收藏列表里的歌就永远是占位图。切歌时先显示快照、再异步向服务端要一次最新地址：
 * 拿到就刷新显示并**写回所属列表**（快照被更新，之后就不必再刷）；失败（如服务端
 * 没装扩展音源）保持快照不动。服务端 getMusicPic 自带缓存，一次调用的成本很低
 * ——Web 端每次显示封面都是现调的。
 */
const refreshAnylistenPic = (musicInfo: LX.Music.MusicInfo) => {
  if (musicInfo.source !== 'anylisten') return
  // 同一首歌只刷一次（写回快照成功后地址已是对的，重复刷没有意义）
  if (lastPicRefreshId === musicInfo.id) return
  lastPicRefreshId = musicInfo.id
  let raw
  try {
    raw = serverMusicInfoOf(toOldMusicInfo(musicInfo))
  } catch {
    return
  }
  void getMusicPic(raw).then((result) => {
    const url = typeof result?.url === 'string' ? result.url : ''
    const resolved = url ? resolveServerUrl(url, getSession().serverUrl) : null
    if (!resolved || resolved === musicInfo.meta.picUrl) return
    musicInfo.meta.picUrl = resolved
    setMusicInfo({ pic: resolved })
    const listId = playerState.playMusicInfo.listId
    if (listId) void updateListMusics([{ id: listId, musicInfo }])
  }).catch(() => {
    /* 拿不到最新地址就保持快照（可能只是旧地址仍有效，或服务端不支持）。
       清掉防抖标记：下次切回这首歌还能再试（成功路径不需要重试） */
    if (lastPicRefreshId === musicInfo.id) lastPicRefreshId = ''
  })
}

const setPlayerMusicInfo = (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem | null) => {
  if (musicInfo) {
    setMusicInfo('progress' in musicInfo ? {
      id: musicInfo.id,
      pic: musicInfo.metadata.musicInfo.meta.picUrl,
      name: musicInfo.metadata.musicInfo.name,
      singer: musicInfo.metadata.musicInfo.singer,
      album: musicInfo.metadata.musicInfo.meta.albumName ?? '',
      lrc: null,
      tlrc: null,
      rlrc: null,
      lxlrc: null,
      rawlrc: null,
    } : {
      id: musicInfo.id,
      pic: musicInfo.meta.picUrl,
      name: musicInfo.name,
      singer: musicInfo.singer,
      album: musicInfo.meta.albumName ?? '',
      lrc: null,
      tlrc: null,
      rlrc: null,
      lxlrc: null,
      rawlrc: null,
    })
    if ('meta' in musicInfo && musicInfo.source === 'anylisten') {
      refreshAnylistenPic(musicInfo)
    }
  } else resetPlayerMusicInfo()
}

/**
 * 设置当前播放歌曲的信息
 * @param listId 歌曲所属的列表id
 * @param musicInfo 歌曲信息
 * @param isTempPlay 是否临时播放
 */
export const setPlayMusicInfo = (listId: string | null, musicInfo: LX.Download.ListItem | LX.Music.MusicInfo | null, isTempPlay: boolean = false) => {
  playerActions.setPlayMusicInfo(listId, musicInfo, isTempPlay)
  setPlayerMusicInfo(musicInfo)

  setProgress(0, 0)

  if (musicInfo == null) {
    playerActions.updatePlayIndex(-1, -1)
    setPlayListId(null)
  } else {
    const { playIndex, playerPlayIndex } = getPlayIndex(listId, musicInfo, isTempPlay)

    playerActions.updatePlayIndex(playIndex, playerPlayIndex)
    global.app_event.musicToggled()
  }
}

export const getList = (listId: string | null): LX.Music.MusicInfo[] | LX.Download.ListItem[] => {
  // return listId == LIST_ID_DOWNLOAD ? downloadList : getListMusicSync(listId)
  return listId == LIST_IDS.DOWNLOAD ? [] : getListMusicSync(listId)
}
