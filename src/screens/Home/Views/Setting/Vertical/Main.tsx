/**
 * 竖向布局的设置页。
 *
 * ## 这里为什么是 FlatList，且 windowSize 必须这么大
 *
 * 上游的虚拟化窗口极小：
 *
 *     maxToRenderPerBatch={2}  windowSize={2}  initialNumToRender={1}
 *
 * 而设置页只有 10 项，内容总高约 5 屏。这个窗口会导致一个具体故障：
 * 焦点落到「服务器地址」输入框时，Android 会把输入框滚到键盘上方，
 * 承载它的那一项因此移出渲染窗口、被卸载 —— 表现是**输入后整页变空白**，
 * 只剩标题栏和底部仍在焦点的输入框，且**日志里没有任何异常**
 * （不是崩溃，是列表把 cell 回收了）。
 *
 * 修法是把窗口开得比内容还大（21 × 视口 ≈ 10 屏 > 内容 5 屏），
 * 于是任何滚动位置下所有项都保持挂载：聚焦的输入框不会被回收，
 * 滚动位置也不会因为虚拟化被重置。10 项全渲染的开销可以接受，
 * 而错误的虚拟化窗口会让页面直接不可用。
 *
 * 保留 FlatList 而不是换成 ScrollView 是有意的：FlatList 内部仍是
 * ScrollView，但它自带 `contentContainerStyle` 的 flex 约束，
 * 且能配合 `keyboardShouldPersistTaps` 正确响应键盘。
 */
import { memo } from 'react'
import { FlatList, type FlatListProps } from 'react-native'

import Basic from '../settings/Basic'
import Player from '../settings/Player'
import LyricDesktop from '../settings/LyricDesktop'
import Search from '../settings/Search'
import List from '../settings/List'
import Sync from '../settings/Sync'
import Backup from '../settings/Backup'
import Other from '../settings/Other'
import Version from '../settings/Version'
import About from '../settings/About'
import { createStyle } from '@/utils/tools'
import { SETTING_SCREENS, type SettingScreenIds } from '../Main'

type FlatListType = FlatListProps<SettingScreenIds>

const styles = createStyle({
  content: {
    paddingLeft: 15,
    paddingRight: 15,
    paddingTop: 15,
    // 键盘弹出时给底部留出空间，否则最下面的项会压在输入法下面
    paddingBottom: 200,
    flex: 0,
  },
})

const ListItem = memo(({ id }: { id: SettingScreenIds }) => {
  switch (id) {
    case 'player': return <Player />
    case 'lyric_desktop': return <LyricDesktop />
    case 'search': return <Search />
    case 'list': return <List />
    case 'sync': return <Sync />
    case 'backup': return <Backup />
    case 'other': return <Other />
    case 'version': return <Version />
    case 'about': return <About />
    case 'basic': return <Basic />
  }
}, () => true)

export default () => {
  const renderItem: FlatListType['renderItem'] = ({ item }) => <ListItem id={item} />
  const getkey: FlatListType['keyExtractor'] = item => item

  return (
    <FlatList
      data={SETTING_SCREENS}
      keyboardShouldPersistTaps={'always'}
      renderItem={renderItem}
      keyExtractor={getkey}
      contentContainerStyle={styles.content}
      // 见文件头：窗口必须大于全部内容，否则聚焦输入框会把所在项回收掉
      maxToRenderPerBatch={10}
      windowSize={21}
      initialNumToRender={10}
    />
  )
}
