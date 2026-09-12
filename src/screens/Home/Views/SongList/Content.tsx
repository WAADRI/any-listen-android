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
    let cancelled = false

    /**
     * 首次加载。
     *
     * 加一次自动重试：曾经出现过「进歌单页是空的，点一下排序（默认）才显示」
     * 的现象 —— 也就是同样的参数**第二次**能成功。那说明首次调用可能发生在
     * 某个协作对象尚未就绪的时刻（ref 链、连接、列表布局），而不是参数有问题。
     *
     * 与其去猜具体是哪一个，这里在「首屏拿到空列表」时自动重试一次：
     * 代价是空歌单会多一次请求，收益是用户不必再手动点一下。
     * 若重试仍为空，那就确实是没有内容，不再纠缠。
     */
    const load = async(attempt: number): Promise<void> => {
      const info = await getSongListSetting()
      if (cancelled) return
      const resolved = resolveSonglistInfo(info)
      songlistInfo.current = resolved
      headerBarRef.current?.setSource(resolved.source, resolved.sortId)
      await listRef.current?.loadList(resolved.source, resolved.sortId, resolved.tagId)
      if (cancelled) return

      const loaded = songlistState.listInfo.list.length
      if (attempt === 0 && loaded === 0) {
        await new Promise(resolve => setTimeout(resolve, 300))
        if (cancelled) return
        await load(1)
      }
    }

    void load(0).catch((err: unknown) => {
      console.log('歌单首屏加载失败:', err)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const handleSortChange: HeaderBarProps['onSortChange'] = (id) => {
    songlistInfo.current.sortId = id
    void saveSongListSetting({ sortId: id })
    listRef.current?.loadList(songlistInfo.current.source, id, songlistInfo.current.tagId)
  }

  const handleSourceChange: HeaderBarProps['onSourceChange'] = (source) => {
    songlistInfo.current.source = source
    songlistInfo.current.tagId = ''
    songlistInfo.current.sortId = songlistState.sortList[source]![0].id
    void saveSongListSetting({ sortId: songlistInfo.current.sortId, source, tagId: '', tagName: '' })
    headerBarRef.current?.setSource(source, songlistInfo.current.sortId)
    listRef.current?.loadList(source, songlistInfo.current.sortId, songlistInfo.current.tagId)
  }

  return (
    <View style={styles.container}>
      <HeaderBar
        ref={headerBarRef}
        onSortChange={handleSortChange}
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

