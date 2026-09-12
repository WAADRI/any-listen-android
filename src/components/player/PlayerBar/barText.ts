/**
 * 底栏副标题该显示什么。
 *
 * ## 规则
 *
 * - **播放中**：显示当前歌词行（`useLrcPlay` 给的那一行）。
 * - **暂停时**：优先显示**状态文字**（加载中 / 报错 / 播放结束 都靠它），
 *   没有状态文字时才回落到当前歌词行。
 *
 * ## 为什么需要这条回退（真机反馈的缺陷）
 *
 * 上游的写法是 `isPlay ? lyricText : statusText` —— 暂停就切成状态文字。
 * 而 `statusText` 在正常播放时会被清成**空串**（`playerEvent.ts` 与
 * `core/init/player/player.ts` 在正常播放/加载完成时都会 `setStatusText('')`），
 * 于是「暂停」就等于把底栏那一行**整个清空**：
 *
 *   - 用户看到的是「一暂停，歌词就没了」；
 *   - 桌面上部的桌面歌词窗口原本也会同时变空（那是另一处，见 `Lyric.java`
 *     的 `pauseLyric()`）。
 *
 * 状态文字仍然享有优先级：真正有信息（加载中 / 播放失败 / 播放结束）时不该被
 * 歌词盖掉；只有它为空的时候才回落到歌词。
 */
export const pickPlayBarText = (isPlay: boolean, lyricText: string, statusText: string): string =>
  isPlay ? lyricText : (statusText || lyricText)
