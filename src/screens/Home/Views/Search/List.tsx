import { forwardRef, useImperativeHandle, useRef, useState } from 'react'
import type { Source as MusicSource } from '@/store/search/music/state'
import MusicList, { type MusicListType } from './MusicList'
import BlankView, { type BlankViewType } from './BlankView'

interface ListProps {
  onSearch: (keyword: string) => void
}
export interface ListType {
  loadList: (text: string, source: MusicSource) => void
}

/**
 * 搜索结果的容器：有关键词就显示结果列表，没有就显示空白态（搜索历史）。
 *
 * 上游这里还有第三个分支 —— 「歌单」标签页的 `SonglistList`。那套歌单搜索
 * 已随 `SearchTypeSelector` 一起删除（它没有对应的服务端能力，且界面会不停闪烁）。
 */
export default forwardRef<ListType, ListProps>(({ onSearch }, ref) => {
  const [showBlankView, setShowListView] = useState(true)
  const listRef = useRef<MusicListType>(null)
  const blankViewRef = useRef<BlankViewType>(null)

  useImperativeHandle(ref, () => ({
    loadList(text, source) {
      if (text) {
        setShowListView(false)
        requestAnimationFrame(() => {
          listRef.current?.loadList(text, source)
        })
      } else {
        setShowListView(true)
        requestAnimationFrame(() => {
          blankViewRef.current?.show(source)
        })
      }
    },
  }), [])

  return (
    showBlankView
      ? <BlankView ref={blankViewRef} onSearch={onSearch} />
      : <MusicList ref={listRef} />
  )
})
