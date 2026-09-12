import { forwardRef, useImperativeHandle, useRef } from 'react'
import { View } from 'react-native'

import SortTab, { type SortTabProps, type SortTabType } from './SortTab'
import { createStyle } from '@/utils/tools'
import SourceSelector, {
  type SourceSelectorType,
  type SourceSelectorProps,
} from './SourceSelector'
import { type Source } from '@/store/songlist/state'

/**
 * 歌单页的顶部栏。
 *
 * ## 与上游的差别：只剩排序 + 音源两项
 *
 * 上游这里还有两个按钮，本 fork 都删掉了，因为它们对应的能力在自建服务上不存在：
 *
 * - **「打开」**（`HeaderBar/OpenList`）：按歌单链接 / 酷狗码打开**商业平台**的歌单。
 *   any-listen 的歌单就是用户自己的，没有可输入的 ID 或链接。
 * - **「标签」**（`HeaderBar/Tag`，默认显示「默认」）：平台的歌单分类筛选。
 *   `getTags()` 返回空标签（any-listen 没有分类），于是下拉里永远只有一项，
 *   点了没有任何变化 —— 留一个按了不动的按钮不如去掉。
 *   随之失效的还有 `SongList/index.tsx` 里那个只为标签抽屉存在的 DrawerLayout。
 */
export interface HeaderBarProps {
  onSortChange: SortTabProps['onSortChange']
  onSourceChange: SourceSelectorProps['onSourceChange']
}

export interface HeaderBarType {
  setSource: (source: Source, sortId: string) => void
}


export default forwardRef<HeaderBarType, HeaderBarProps>(({ onSortChange, onSourceChange }, ref) => {
  const sortTabRef = useRef<SortTabType>(null)
  const sourceSelectorRef = useRef<SourceSelectorType>(null)

  useImperativeHandle(ref, () => ({
    setSource(source, sortId) {
      sortTabRef.current?.setSource(source, sortId)
      sourceSelectorRef.current?.setSource(source)
    },
  }), [])


  return (
    <View style={styles.searchBar}>
      <SortTab ref={sortTabRef} onSortChange={onSortChange} />
      <SourceSelector ref={sourceSelectorRef} onSourceChange={onSourceChange} />
    </View>
  )
})

const styles = createStyle({
  searchBar: {
    flexDirection: 'row',
    height: 38,
    zIndex: 2,
  },
  selector: {
    width: 86,
  },
})
