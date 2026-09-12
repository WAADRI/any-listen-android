import Content from './Content'

/**
 * 歌单页。
 *
 * 上游这里套了一个 `DrawerLayout`，抽屉里装的是「歌单分类标签」筛选
 * （由 `HeaderBar` 的标签按钮通过 `showSonglistTagList` 事件打开）。
 * any-listen 没有歌单分类、`getTags()` 返回空标签，那个按钮已删除，
 * 抽屉也就没有任何内容可装 —— 所以整块去掉，直接渲染内容。
 */
export default () => <Content />
