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
          // 恢复数据时必须连同分页状态一起恢复：组件重挂后 Songlist 内部的
          // status 回到初值 idle，单页列表会被划到底的 onEndReached 误触发加载
          listRef.current?.setStatus(songlistState.listInfo.maxPage <= songlistState.listInfo.page ? 'end' : 'idle')
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
    const nextPage = songlistState.listInfo.list.length ? songlistState.listInfo.page + 1 : 1
    // 已到最后一页就不再请求。这里不能依赖 UI 的 status 拦截：横屏侧边栏切页会
    // 卸载重挂歌单组件，status 回到初值 idle，划到底就会带着越界的页码请求——
    // anylisten 适配层对越界页会**钳回第 1 页**返回，而下面的 setList 按传入的
    // 页码走追加分支，于是整个第 1 页被拼接到列表底部（真机横屏实测的重复加载）。
    if (nextPage > songlistState.listInfo.maxPage) {
      listRef.current?.setStatus('end')
      return
    }
    listRef.current?.setStatus('loading')
    const page = nextPage
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

