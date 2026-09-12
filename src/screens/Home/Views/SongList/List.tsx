import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import Songlist, { type SonglistProps, type SonglistType } from './components/Songlist'
import { clearList, getList, setList, setListInfo } from '@/core/songlist'
import songlistState from '@/store/songlist/state'
import { type Source } from '@/store/songlist/state'


export interface ListType {
  /**
   * 加载歌单列表。
   *
   * 返回 promise 是**有意**的（实现里本来就 return 了 `getList(...)`）：
   * 调用方需要知道「这一页拉完了」，才能判断首屏是不是真的为空。
   * 早先这里标成 `void`，调用方就无法等待，也就没法自动重试空首屏。
   */
  loadList: (source: Source, sortId: string, tagId: string) => Promise<void>
}

export default forwardRef<ListType, {}>((props, ref) => {
  const listRef = useRef<SonglistType>(null)
  const isUnmountedRef = useRef(false)
  useImperativeHandle(ref, () => ({
    async loadList(source, sortId, tagId) {
      const listInfo = songlistState.listInfo
      listRef.current?.setList([])
      if (listInfo.tagId == tagId && listInfo.sortId == sortId && listInfo.source == source && listInfo.list.length) {
        requestAnimationFrame(() => {
          listRef.current?.setList(listInfo.list)
        })
      } else {
        listRef.current?.setStatus('loading')
        setListInfo(source, tagId, sortId)
        const page = 1
        return getList(source, tagId, sortId, page).then((info) => {
          const result = setList(info, tagId, sortId, page)
          if (isUnmountedRef.current) return
          requestAnimationFrame(() => {
            listRef.current?.setList(result.list)
            listRef.current?.setStatus(songlistState.listInfo.maxPage <= page ? 'end' : 'idle')
          })
        }).catch(() => {
          if (songlistState.listInfo.list.length && page == 1) clearList()
          listRef.current?.setStatus('error')
        })
      }
    },
  }), [])

  useEffect(() => {
    isUnmountedRef.current = false
    return () => {
      isUnmountedRef.current = true
    }
  }, [])


  const handleRefresh: SonglistProps['onRefresh'] = () => {
    const page = 1
    listRef.current?.setStatus('refreshing')
    getList(songlistState.listInfo.source, songlistState.listInfo.tagId, songlistState.listInfo.sortId, page, true).then((info) => {
      const result = setList(info, songlistState.listInfo.tagId, songlistState.listInfo.sortId, page)
      if (isUnmountedRef.current) return
      listRef.current?.setList(result.list)
      listRef.current?.setStatus(songlistState.listInfo.maxPage <= page ? 'end' : 'idle')
    }).catch(() => {
      if (songlistState.listInfo.list.length && page == 1) clearList()
      listRef.current?.setStatus('error')
    })
  }
  const handleLoadMore: SonglistProps['onLoadMore'] = () => {
    listRef.current?.setStatus('loading')
    const page = songlistState.listInfo.list.length ? songlistState.listInfo.page + 1 : 1
    getList(songlistState.listInfo.source, songlistState.listInfo.tagId, songlistState.listInfo.sortId, page).then((info) => {
      const result = setList(info, songlistState.listInfo.tagId, songlistState.listInfo.sortId, page)
      if (isUnmountedRef.current) return
      listRef.current?.setList(result.list)
      listRef.current?.setStatus(songlistState.listInfo.maxPage <= page ? 'end' : 'idle')
    }).catch(() => {
      if (songlistState.listInfo.list.length && page == 1) clearList()
      listRef.current?.setStatus('error')
    })
  }

  return <Songlist
    ref={listRef}
    onRefresh={handleRefresh}
    onLoadMore={handleLoadMore}
   />
})

