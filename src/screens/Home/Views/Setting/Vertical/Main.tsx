/**
 * 竖向布局的设置页。
 *
 * ## 为什么用 ScrollView 而不是上游的 FlatList
 *
 * 上游这里是一个高度虚拟化的 FlatList：
 *
 *     maxToRenderPerBatch={2}  windowSize={2}  initialNumToRender={1}
 *
 * 对一个只有十项的设置列表来说，这个窗口太小了。焦点落在「服务器地址」
 * 输入框上时，Android 会把输入框滚动到键盘上方，而这个过程会让所在的项
 * 移出渲染窗口、被卸载 —— 表现就是**输入后整页内容变空白**，只剩标题栏
 * 和底部仍在焦点的输入框，而且**日志里没有任何异常**（不是崩溃，是列表
 * 把内容回收了）。
 *
 * 十项内容全部渲染的代价可以忽略，而它换来两个必要的性质：
 *
 * 1. 聚焦的输入框不会被回收；
 * 2. 滚动位置不会被虚拟化重置。
 *
 * 若将来设置项显著变多，应当提高 windowSize，而不是回到这么小的窗口。
 */
import { memo } from 'react'
import { ScrollView } from 'react-native'

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

const styles = createStyle({
  content: {
    paddingLeft: 15,
    paddingRight: 15,
    paddingTop: 15,
    // 键盘弹出时给底部留出空间，否则最下面的项会压在输入法下面
    paddingBottom: 200,
  },
})

export default memo(() => (
  <ScrollView
    keyboardShouldPersistTaps="always"
    contentContainerStyle={styles.content}
  >
    <Basic />
    <Player />
    <LyricDesktop />
    <Search />
    <List />
    <Sync />
    <Backup />
    <Other />
    <Version />
    <About />
  </ScrollView>
))
