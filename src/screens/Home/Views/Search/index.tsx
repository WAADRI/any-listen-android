import { useRef, useEffect } from 'react'
import { type LayoutChangeEvent, View } from 'react-native'

import HeaderBar, { type HeaderBarProps, type HeaderBarType } from './HeaderBar'
import searchState from '@/store/search/state'
import searchMusicState from '@/store/search/music/state'
import { getSearchSetting, saveSearchSetting } from '@/utils/data'
import { createStyle } from '@/utils/tools'
import TipList, { type TipListType } from './TipList'
import List, { type ListType } from './List'
import { addHistoryWord } from '@/core/search/search'

/**
 * 搜索页。
 *
 * ## 与上游的差别：没有「歌曲 / 歌单」切换
 *
 * 上游顶部有 `SearchTypeSelector`，可以切换到「歌单」去搜各平台的歌单广场。
 * 本 fork 里那个标签页没有任何意义，而且**界面会不停闪烁**（`SonglistList`
 * 与 `Songlist` 的加载态互相触发），所以连同整套歌单搜索一起删掉了：
 * `SearchTypeSelector`、`SonglistList`、`core/search/songlist.ts`、
 * `store/search/songlist/`，以及适配器里为此实现的 `songList.search`。
 *
 * 搜索现在只有一个对象：本机曲库（见 `utils/anylisten/rank.ts`）。
 */
export default () => {
  const headerBarRef = useRef<HeaderBarType>(null)
  const searchTipListRef = useRef<TipListType>(null)
  const listRef = useRef<ListType>(null)
  const layoutHeightRef = useRef<number>(0)
  const sourceRef = useRef<LX.OnlineSource>('anylisten')
  const timeoutRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    void getSearchSetting().then(info => {
      /**
       * 设置是**持久化**的，可能存着已经不存在的源。
       *
       * 最典型的是 `'all'`（聚合大会）：本 fork 只有 anylisten 一个源，
       * 那个入口已从源列表里删掉，但老版本存的 `source: 'all'` 还在。
       * 不校验的话，源选择器会显示一个不在下拉列表里的源，点开也只有一项。
       */
      const sources = searchMusicState.sources
      const source = (sources.includes(info.source) ? info.source : sources[0] ?? 'anylisten') as LX.OnlineSource
      sourceRef.current = source

      headerBarRef.current?.setSourceList(sources, source)
      headerBarRef.current?.setText(searchState.searchText)
      listRef.current?.loadList(searchState.searchText, source)
    })
  }, [])


  const handleLayout = (e: LayoutChangeEvent) => {
    layoutHeightRef.current = e.nativeEvent.layout.height
  }

  const handleSourceChange: HeaderBarProps['onSourceChange'] = (source) => {
    sourceRef.current = source
    void saveSearchSetting({ source })
    listRef.current?.loadList(searchState.searchText, source)
  }
  const handleTipSearch: HeaderBarProps['onTipSearch'] = (text) => {
    setTimeout(() => {
      searchTipListRef.current?.search(text, layoutHeightRef.current)
    }, 500)
  }
  const handleHideTipList = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
    searchTipListRef.current?.hide()
  }
  const handleSearch: HeaderBarProps['onSearch'] = (text) => {
    handleHideTipList()
    searchTipListRef.current?.search(text, layoutHeightRef.current)
    headerBarRef.current?.setText(text)
    headerBarRef.current?.blur()
    void addHistoryWord(text)
    listRef.current?.loadList(text, sourceRef.current)
  }
  const handleShowTipList: HeaderBarProps['onShowTipList'] = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current)
    timeoutRef.current = setTimeout(() => {
      searchTipListRef.current?.show(layoutHeightRef.current)
    }, 500)
  }

  return (
    <View style={styles.container}>
      <HeaderBar
        ref={headerBarRef}
        onSourceChange={handleSourceChange}
        onTipSearch={handleTipSearch}
        onSearch={handleSearch}
        onHideTipList={handleHideTipList}
        onShowTipList={handleShowTipList}
      />
      <View style={styles.content} onLayout={handleLayout}>
        <TipList ref={searchTipListRef} onSearch={handleSearch} />
        <List ref={listRef} onSearch={handleSearch} />
      </View>
    </View>
  )
}

const styles = createStyle({
  container: {
    width: '100%',
    flex: 1,
  },
  content: {
    flex: 1,
  },
})
