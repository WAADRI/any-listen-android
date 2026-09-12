/**
 * 搜索页的全局状态。
 *
 * 上游还有 `searchType: 'music' | 'songlist'`（「歌曲 / 歌单」两个标签页）。
 * 歌单搜索已整体删除（没有对应的服务端能力，而且那个标签页会让界面不停闪烁），
 * 所以这里也不再需要搜索类型。
 */
export interface InitState {
  temp_source: 'anylisten'
  // temp_source: LX.OnlineSource
  searchText: string
  tipListInfo: {
    text: string
    source: 'anylisten'
    list: string[]
  }
  historyList: string[]
}

const state: InitState = {
  temp_source: 'anylisten',
  searchText: '',
  tipListInfo: {
    text: '',
    source: 'anylisten',
    list: [],
  },
  historyList: [],
}


export default state
