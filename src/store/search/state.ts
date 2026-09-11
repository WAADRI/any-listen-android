export type SearchType = 'music' | 'songlist'

export interface InitState {
  temp_source: 'anylisten'
  // temp_source: LX.OnlineSource
  searchType: SearchType
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
  searchType: 'music',
  searchText: '',
  tipListInfo: {
    text: '',
    source: 'anylisten',
    list: [],
  },
  historyList: [],
}


export default state
