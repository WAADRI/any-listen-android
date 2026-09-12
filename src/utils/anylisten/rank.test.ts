/**
 * 本地曲库搜索规则的单测。
 *
 * ## 这些规则各自防的是什么
 *
 * 1. **`source` 字段必须回传**：`store/search/music/action.ts` 的 `setList()`
 *    用 `datas.source` 取 `state.listInfos[datas.source]`。缺了它，单源搜索一按
 *    回车就抛 `TypeError: Cannot read property 'list' of undefined`，
 *    而「聚合大会」那条分支恰好不读 `source`，所以表现为「换个 tab 就好了」。
 *    真机日志里就是这一类错误，但被 `MusicList` 的 `.catch` 吞掉了。
 *
 * 2. **只索引本地文件**：真机实测（`tools/ws-probe-library.mjs`）1670 首里有
 *    16 首是**在线引用**（`isLocal: false`、没有 `filePath`），其中 8 首与本地文件
 *    重名。在线引用能不能播取决于服务端当下的状态（有时返回真实地址、有时返回
 *    `./gdstudio-no-url` 占位值 → 点了报「该曲目可能已从曲库移除」），所以整个
 *    索引只保留本地文件。把真实曲库喂给本模块验证过：1670 → 1654（去掉那 16 首）。
 *
 * 3. **同名去重**：同一首歌的本地副本与在线引用只留本地那条，且去重后
 *    **没有任何**同名同歌手的行。
 *
 * 3. **联想项必须是可直接再次搜索的词**：联想项被点击后直接作为搜索词，
 *    返回「歌名 - 歌手」这种组合会搜不到东西。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildTips, dedupePreferLocal, isLocalTrack, searchTracks, selectPlayableTracks } from './rank'
import type { AnyListenMusicInfo } from './types'

/** 造一首服务端曲目。默认是本地文件（id 就是文件路径，且有 filePath）。 */
function track(name: string, singer: string, extra: Partial<AnyListenMusicInfo> = {}): AnyListenMusicInfo {
  const id = extra.id ?? `/music/${singer} - ${name}.mp3`
  const isLocal = extra.isLocal ?? true
  return {
    id,
    name,
    singer,
    interval: '04:00',
    isLocal,
    // 真实数据里本地文件一定有 filePath，在线引用一定没有
    meta: { musicId: id, albumName: '', ...(isLocal ? { filePath: id } : {}) },
    ...extra,
  }
}

test('搜索结果必须带上 source，否则单源搜索一按回车就崩', () => {
  const result = searchTracks([track('恋人', '李荣浩')], '恋人')

  assert.equal(result.source, 'anylisten')
  assert.equal(result.total, 1)
  assert.equal(result.list.length, 1)
  // 少了这个字段，store/search/music/action.ts 的 setList 会在 undefined 上取属性
  assert.ok('source' in result, 'searchTracks 的返回值必须包含 source')
})

test('空关键词返回空结果，且仍然带上 source', () => {
  const result = searchTracks([track('恋人', '李荣浩')], '   ')

  assert.deepEqual(result.list, [])
  assert.equal(result.total, 0)
  assert.equal(result.source, 'anylisten')
})

test('排序：完全相等 > 前缀 > 歌名包含 > 歌手命中', () => {
  const tracks = [
    track('江南', '林俊杰'),
    track('江南梦', '某人'),
    track('梦江南', '某人'),
    track('别的', '江南'),
  ]
  const list = searchTracks(tracks, '江南').list

  assert.deepEqual(list.map(i => i.name), ['江南', '江南梦', '梦江南', '别的'])
})

test('分页与总数字段自洽', () => {
  const tracks = Array.from({ length: 7 }, (_, i) => track(`歌${i}`, '某人'))
  const first = searchTracks(tracks, '歌', 1, 3)
  const third = searchTracks(tracks, '歌', 3, 3)

  assert.equal(first.total, 7)
  assert.equal(first.allPage, 3)
  assert.equal(first.list.length, 3)
  assert.equal(third.list.length, 1)
  assert.equal(third.source, 'anylisten')
})

test('只索引本地文件：在线引用一律不进曲库索引', () => {
  const tracks = [
    track('恋人', '李荣浩'),
    // 真机里的真实形态：同一首歌的腾讯 / 网易引用
    track('恋人', '李荣浩', { id: '001auUcH4WQs2V', isLocal: false }),
    // 只有在线形态、没有本地文件的歌，同样不索引（点了大概率报「占位值」）
    track('星火照途', '某人', { id: '002pdnAG153maG', isLocal: false }),
  ]
  const kept = selectPlayableTracks(tracks)

  assert.deepEqual(kept.map(t => t.id), ['/music/李荣浩 - 恋人.mp3'])
  assert.ok(kept.every(t => t.isLocal === true))
})

test('漏了 isLocal 字段但有 filePath 的本地文件不能被丢掉', () => {
  const noFlag = track('某歌', '某人')
  delete (noFlag as { isLocal?: boolean }).isLocal

  assert.equal(isLocalTrack(noFlag), true)
  assert.equal(selectPlayableTracks([noFlag]).length, 1)
})

test('既没有 isLocal 也没有 filePath 的条目会被丢掉', () => {
  const online = {
    id: '555',
    name: '只有在线引用',
    singer: '某人',
    interval: null,
    meta: { musicId: '555' },
  } as AnyListenMusicInfo

  assert.equal(isLocalTrack(online), false)
  assert.equal(selectPlayableTracks([online]).length, 0)
})

test('同一首歌的本地与在线引用只留一条，且留本地', () => {
  // 真机实测的真实形态：本地文件 + 腾讯 + 网易三条
  const tracks = [
    track('恋人', '李荣浩', { id: '001auUcH4WQs2V', isLocal: false }),
    track('恋人', '李荣浩'),
    track('恋人', '李荣浩', { id: '2600493765', isLocal: false }),
  ]
  const deduped = dedupePreferLocal(tracks)

  assert.equal(deduped.length, 1)
  assert.equal(deduped[0].isLocal, true)
  assert.equal(deduped[0].id, '/music/李荣浩 - 恋人.mp3')
})

test('没有本地副本时保留第一条，不丢歌', () => {
  const tracks = [
    track('COPDD', '宋雨琦', { id: '004UcTMG0yS4Re', isLocal: false }),
    track('COPDD', '宋雨琦', { id: '489606299', isLocal: false }),
  ]
  const deduped = dedupePreferLocal(tracks)

  assert.equal(deduped.length, 1)
  assert.equal(deduped[0].id, '004UcTMG0yS4Re')
})

test('有本地副本时，**时长不一致**的在线引用也要丢掉', () => {
  // 真实数据里 `可能 - 程响` / `COPDD - 宋雨琦…` 就是这种形态：在线引用的时长
  // 与本地文件不一致。只比时长的规则会把它们留成第二行，而界面上那两行的
  // 歌名歌手一模一样 —— 用户只会看到「同一首歌出现了两次」，其中一条还点不响。
  const tracks = [
    track('可能', '程响'),
    track('可能', '程响', { id: '002i54Mn1oJnjw', isLocal: false, interval: '04:05' }),
    track('可能', '程响', { id: '1139574711', isLocal: false, interval: '04:00' }),
  ]
  const deduped = dedupePreferLocal(tracks)

  assert.equal(deduped.length, 1)
  assert.equal(deduped[0].isLocal, true)
})

test('没有本地副本时，时长不同按两首歌保留（宁可多留也不丢歌）', () => {
  const tracks = [
    track('某歌', '某人', { id: 'a', isLocal: false }),
    track('某歌', '某人', { id: 'b', isLocal: false, interval: '05:12' }),
  ]

  assert.equal(dedupePreferLocal(tracks).length, 2)
})

test('时长不同不算同一首歌（原版与 Live 都要留着）', () => {
  const tracks = [
    track('如果爱忘了', '某人'),
    track('如果爱忘了', '某人', { id: '/music/live.mp3', interval: '05:12' }),
  ]

  assert.equal(dedupePreferLocal(tracks).length, 2)
})

test('去重保持首次出现的顺序', () => {
  const tracks = [
    track('A', 'x'),
    track('B', 'y'),
    track('A', 'x', { id: '/music/A2.mp3', isLocal: false }),
    track('C', 'z'),
  ]

  assert.deepEqual(dedupePreferLocal(tracks).map(t => t.name), ['A', 'B', 'C'])
})

test('联想项是能直接再搜的词，不是「歌名 - 歌手」', () => {
  const tracks = [
    track('恋人', '李荣浩'),
    track('恋爱循环', '某人'),
    track('别的', '恋人们'),
  ]
  const tips = buildTips(tracks, '恋')

  assert.deepEqual(tips, ['恋人', '恋爱循环', '恋人们'])
  // 每一项拿去再搜，都必须能搜到东西 —— 否则点了联想项等于白点
  for (const tip of tips) {
    assert.ok(searchTracks(tracks, tip).total > 0, `联想项「${tip}」再次搜索必须有结果`)
  }
  assert.ok(!tips.some(t => t.includes(' - ')), '不得返回「歌名 - 歌手」这种组合')
})

test('联想项去重且受 limit 限制', () => {
  const tracks = [
    track('恋人', '李荣浩'),
    track('恋人', '李荣浩', { id: '/music/x.mp3', isLocal: false }),
    track('恋人啊', '某人'),
  ]

  assert.deepEqual(buildTips(tracks, '恋', 1), ['恋人'])
  assert.deepEqual(buildTips(tracks, '恋', 10), ['恋人', '恋人啊'])
  assert.deepEqual(buildTips(tracks, ''), [])
})
