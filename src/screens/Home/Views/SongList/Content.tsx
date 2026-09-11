import { getSongListSetting, saveSongListSetting } from '@/utils/data'
import { useEffect, useRef } from 'react'
import { StyleSheet, View } from 'react-native'

// import List from './List/List'
import HeaderBar, { type HeaderBarProps, type HeaderBarType } from './HeaderBar'
import songlistState, { type InitState, type SortInfo } from '@/store/songlist/state'
import List, { type ListType } from './List'


interface SonglistInfo {
  source: InitState['sources'][number]
  sortId: SortInfo['id']
  tagId: string
}

/**
 * 取一个当前真正可用的歌单源。
 *
 * 必要性：这里原先硬编码 `{ source: 'kw', sortId: '5' }`，而本 fork 只实现了
 * `anylisten` 一个源。只要读到旧版本留下的设置（`common` 里持久化的
 * `source: 'kw'`），`musicSdk['kw']` 就是 undefined，
 * 歌单页会**一直空白且不报错**。
 *
 * 所以所有来源都要校验一遍，任何一项不可用就回退到当前可用的源与排序。
 */
function resolveSonglistInfo(info: { source?: string, sortId?: string, tagId?: string }): SonglistInfo {
  const available = songlistState.sources
  const source = (available.includes(info.source as InitState['sources'][number])
    ? info.source
    : available[0]) as InitState['sources'][number] | undefined

  if (!source) return { source: 'anylisten' as InitState['sources'][number], sortId: 'all' as SortInfo['id'], tagId: '' }

  const sorts = songlistState.sortList[source] ?? []
  const sortId = (sorts.some(s => s.id === info.sortId) ? info.sortId : sorts[0]?.id ?? 'all') as SortInfo['id']

  return { source, sortId, tagId: info.tagId ?? '' }
}

export default () => {
  const headerBarRef = useRef<HeaderBarType>(null)
  const listRef = useRef<ListType>(null)
  // 初值也要是有效值：设置读取是异步的，读取期间界面已经渲染过一次
  const songlistInfo = useRef<SonglistInfo>(resolveSonglistInfo({}))

  useEffect(() => {
    void getSongListSetting().then(info => {
      const resolved = resolveSonglistInfo(info)
      songlistInfo.current = resolved
      headerBarRef.current?.setSource(resolved.source, resolved.sortId, info.tagName, resolved.tagId)
      listRef.current?.loadList(resolved.source, resolved.sortId, resolved.tagId)
    })
  }, [])

  const handleSortChange: HeaderBarProps['onSortChange'] = (id) => {
    songlistInfo.current.sortId = id
    void saveSongListSetting({ sortId: id })
    listRef.current?.loadList(songlistInfo.current.source, id, songlistInfo.current.tagId)
  }

  const handleTagChange: HeaderBarProps['onTagChange'] = (name, id) => {
    songlistInfo.current.tagId = id
    void saveSongListSetting({ tagName: name, tagId: id })
    listRef.current?.loadList(songlistInfo.current.source, songlistInfo.current.sortId, id)
  }

  const handleSourceChange: HeaderBarProps['onSourceChange'] = (source) => {
    songlistInfo.current.source = source
    songlistInfo.current.tagId = ''
    songlistInfo.current.sortId = songlistState.sortList[source]![0].id
    void saveSongListSetting({ sortId: songlistInfo.current.sortId, source, tagId: '', tagName: '' })
    headerBarRef.current?.setSource(source, songlistInfo.current.sortId, '', songlistInfo.current.tagId)
    listRef.current?.loadList(source, songlistInfo.current.sortId, songlistInfo.current.tagId)
  }

  return (
    <View style={styles.container}>
      <HeaderBar
        ref={headerBarRef}
        onSortChange={handleSortChange}
        onTagChange={handleTagChange}
        onSourceChange={handleSourceChange}
      />
      <List ref={listRef} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    flex: 1,
  },
})

