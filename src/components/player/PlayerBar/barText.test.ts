/**
 * 底栏副标题取值的回归测试。
 *
 * 真机缺陷：暂停播放时，底栏那一行歌词（以及桌面歌词窗口）都会变空。
 * 底栏这一半的原因就是「暂停时无条件切成状态文字」，而状态文字平时是空串。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { pickPlayBarText } from './barText'

test('播放中显示歌词行', () => {
  assert.equal(pickPlayBarText(true, '恋人 - 李荣浩', ''), '恋人 - 李荣浩')
  // 播放中即使有状态文字也以歌词为准（上游行为，保持不变）
  assert.equal(pickPlayBarText(true, '恋人', '正在缓冲'), '恋人')
})

test('暂停且没有状态文字时**保留**歌词行，不能清空', () => {
  // 暂停时 statusText 已被清成空串，这就是「一暂停歌词就没了」的原因
  assert.equal(pickPlayBarText(false, '恋人 - 李荣浩', ''), '恋人 - 李荣浩')
})

test('暂停时状态文字优先（加载中 / 报错 / 播放结束 不能被歌词盖掉）', () => {
  assert.equal(pickPlayBarText(false, '恋人', '正在加载'), '正在加载')
  assert.equal(pickPlayBarText(false, '恋人', '歌词获取失败'), '歌词获取失败')
})

test('没有歌词也没有状态时就是空串', () => {
  assert.equal(pickPlayBarText(false, '', ''), '')
  assert.equal(pickPlayBarText(true, '', ''), '')
})
