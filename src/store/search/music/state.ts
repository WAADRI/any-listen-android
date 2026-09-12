import music from '@/utils/musicSdk'

export declare interface ListInfo {
  list: LX.Music.MusicInfoOnline[]
  total: number
  page: number
  maxPage: number
  limit: number
  key: string | null
}

interface ListInfos extends Partial<Record<LX.OnlineSource, ListInfo>> {
  'all': ListInfo
}

export type Source = LX.OnlineSource | 'all'

export interface InitState {
  searchText: string
  source: Source
  sources: Source[]
  listInfos: ListInfos
  maxPages: Partial<Record<LX.OnlineSource, number>>
}

const state: InitState = {
  searchText: '',
  source: 'anylisten',
  sources: [],
  listInfos: {
    all: {
      page: 1,
      maxPage: 0,
      limit: 30,
      total: 0,
      list: [],
      key: null,
    },
  },
  maxPages: {},
}

for (const source of music.sources) {
  if (!music[source.id as LX.OnlineSource]?.musicSearch) continue
  state.sources.push(source.id as LX.OnlineSource)
  state.listInfos[source.id as LX.OnlineSource] = {
    page: 1,
    maxPage: 0,
    limit: 30,
    total: 0,
    list: [],
    key: '',
  }
  state.maxPages[source.id as LX.OnlineSource] = 0
}
// 不再提供「聚合大会」（`'all'`）：本 fork 只有 anylisten 一个源，
// 「聚合」与单源搜索的结果完全相同，多一个入口只会让人以为能搜到别的东西。
// `listInfos.all` 与 `core/search/music.ts` 里的 `'all'` 分支保留着，
// 但已没有任何界面能把 source 设成 `'all'`。

export default state
