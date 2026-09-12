// import { dateFormat } from '@/utils/common'
import { setListUpdateTime } from '@/utils/data'
import { overwriteListMusics, setFetchingListStatus } from './list'
import { getListDetailAll } from '@/core/songlist'

/**
 * 把「收藏的在线歌单」重新从音源拉一遍，覆盖本地列表内容。
 *
 * 上游这里还为 `board__` 前缀的榜单歌单留了一个分支（走 `core/leaderboard`）。
 * 排行榜已随商业音源一起移除，`sourceListId` 不可能再有那个前缀，故删掉该分支。
 */
const fetchList = async(id: string, source: LX.OnlineSource, sourceListId: string) => {
  setFetchingListStatus(id, true)
  return getListDetailAll(source, sourceListId, true).finally(() => {
    setFetchingListStatus(id, false)
  })
}

export default async(targetListInfo: LX.List.UserListInfo) => {
  // console.log(targetListInfo)
  if (!targetListInfo.source || !targetListInfo.sourceListId) return
  const list = await fetchList(targetListInfo.id, targetListInfo.source, targetListInfo.sourceListId)
  // console.log(list)
  void overwriteListMusics(targetListInfo.id, list)
  const now = Date.now()
  void setListUpdateTime(targetListInfo.id, now)
  // TODO
  // setUpdateTime(targetListInfo.id, dateFormat(now))
}
