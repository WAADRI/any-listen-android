import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAwlrc, parseTimeLabel, playedCount, findAwlrcLine, awlrcOf, lineStyleKind } from './awlrc'

// 下面这段是**服务端真实返回**的 awlyric（`tools/ws-dump-awlrc.mjs` 原样 dump，
// 曲目：2026一定会幸福 (女声版) - 諾然）。断言值全部按这段真实数据写死，
// 不要凭想象改。
const REAL = `[offset:0]
[00:00.111]<0,302>2026<302,179>一<481,176>定<657,174>会<831,178>幸<1009,89>福<1099,89> (<1188,155>女<1343,162>声<1505,149>版<1654,149>) - <1803,159>諾<1962,150>然
[00:02.223]<0,150>词<150,0>：<150,153>諾<303,153>然
[00:02.679]<0,139>曲<139,0>：<139,144>諾<283,147>然
[00:03.109]<0,140>制<140,129>作<269,154>人<423,0>：<423,123>晨<546,236>汐
[00:04.755]<0,467>2026 <467,227>我<1252,169>一<1421,142>定<1563,132>会<1695,140>幸<1835,115>福<1950,103>的
[00:12.134]<0,176>窗<176,159>外<335,144>的<479,345>风<824,351>吹<1175,173>得<1348,327>有<1675,162>点<1837,332>冷
[00:14.992]<0,166>手<166,139>里<305,162>这<467,144>杯<611,318>热<929,294>茶<1223,179>氤<1402,176>氲<1578,202>着<1780,305>气<2085,485>温`

test('parseTimeLabel 支持 mm:ss.xxx 与 hh:mm:ss.xxx', () => {
  assert.equal(parseTimeLabel('[00:00.111]'), 111)
  assert.equal(parseTimeLabel('[00:02.223]'), 2223)
  assert.equal(parseTimeLabel('[01:02.003]'), 62_003)
  assert.equal(parseTimeLabel('[1:02:03.400]'), 3_723_400)
  assert.equal(parseTimeLabel('[00:04.75]'), 4750) // 补零到毫秒
  assert.equal(parseTimeLabel('[xx:yy.zzz]'), null)
})

test('真实 awlyric：跳过 [offset:0] 头行，行时间与普通歌词一致', () => {
  const aw = parseAwlrc(REAL)
  assert.equal(aw.hasWordTiming, true)
  assert.equal(aw.lines.length, 7)
  // 行时间戳原样解析（无 offset）
  assert.deepEqual(aw.lines.map(l => l.timeMs), [111, 2223, 2679, 3109, 4755, 12_134, 14_992])
})

test('真实 awlyric：正文 = 各段文字拼接（标签会被去掉）', () => {
  const aw = parseAwlrc(REAL)
  assert.equal(aw.lines[0].text, '2026一定会幸福 (女声版) - 諾然')
  assert.equal(aw.lines[1].text, '词：諾然')
  assert.equal(aw.lines[4].text, '2026 我一定会幸福的')
  // 逐行歌词里 body 就是这一行的原文
  assert.equal(aw.lines[5].text, '窗外的风吹得有点冷')
})

test('真实 awlyric：段起点是相对本行、按字切分、允许零时长', () => {
  const aw = parseAwlrc(REAL)
  const first = aw.lines[0].segments
  assert.deepEqual(first.slice(0, 4), [
    { text: '2026', startMs: 0, durationMs: 302 },
    { text: '一', startMs: 302, durationMs: 179 },
    { text: '定', startMs: 481, durationMs: 176 },
    { text: '会', startMs: 657, durationMs: 174 },
  ])
  // 数字/空格成段，CJK 逐字
  assert.equal(first[first.length - 1].text, '然')
  assert.equal(first[first.length - 1].startMs, 1962)

  // 零时长段真实存在（`：` 这类），不能被丢掉
  const zero = aw.lines[1].segments.find(s => s.durationMs === 0)
  assert.ok(zero, '应保留 0 时长段')
  assert.equal(zero.text, '：')

  // 相对本行的佐证：首行末段结束 == 下一行时间 - 本行时间
  const last = first[first.length - 1]
  assert.equal(last.startMs + last.durationMs, 2223 - 111)
})

test('playedCount：到点即算已唱，段间留白不倒退', () => {
  const segs = parseAwlrc(REAL).lines[4].segments // <0,467>2026 <467,227>我<1252,169>一…
  assert.equal(playedCount(segs, -1), 0)
  assert.equal(playedCount(segs, 0), 1)
  assert.equal(playedCount(segs, 466), 1)
  assert.equal(playedCount(segs, 467), 2)
  // 467+227=694 到 1252 之间是留白：仍停在 2，不会跳到后面
  assert.equal(playedCount(segs, 1000), 2)
  assert.equal(playedCount(segs, 1252), 3)
  assert.equal(playedCount(segs, 10_000), segs.length)
})

test('没有逐字信息的行退回逐行，不影响其它行', () => {
  const mixed = `[offset:0]
[00:01.000]<0,100>逐<100,100>字
[00:03.000]只是普通歌词
[00:05.000]<0,100>又<100,100>是逐字`
  const aw = parseAwlrc(mixed)
  assert.equal(aw.hasWordTiming, true)
  assert.deepEqual(aw.lines.map(l => l.text), ['逐字', '只是普通歌词', '又是逐字'])
  assert.equal(aw.lines[1].segments.length, 0)
  assert.equal(aw.lines[0].segments.length, 2)
})

test('行首有散字时整行退回逐行（与 any-listen 前瞻切分一致）', () => {
  const aw = parseAwlrc('[00:01.000]前<0,100>缀<100,100>段')
  assert.equal(aw.lines[0].segments.length, 0)
  assert.equal(aw.lines[0].text, '前缀段')
  assert.equal(aw.hasWordTiming, false)
})

test('offset 对整首生效，且行按时间排序', () => {
  const aw = parseAwlrc('[offset:200]\n[00:05.000]<0,10>后\n[00:01.000]<0,10>前')
  assert.deepEqual(aw.lines.map(l => l.timeMs), [1200, 5200])
  assert.deepEqual(aw.lines.map(l => l.text), ['前', '后'])
  // 负值也是合法的（提前）
  assert.equal(parseAwlrc('[offset:-500]\n[00:01.000]<0,10>a').lines[0].timeMs, 500)
})

test('空输入与异常输入不炸', () => {
  for (const input of [null, undefined, '', '\n\n', '[offset:0]', 'not a lyric at all']) {
    const aw = parseAwlrc(input as string)
    assert.equal(aw.lines.length, 0)
    assert.equal(aw.hasWordTiming, false)
  }
  // 没有时间戳的裸文本行被跳过（避免和 lrc-file-parser 的行列表错位）
  assert.equal(parseAwlrc('随便一行没有时间戳\n[00:01.000]<0,10>x').lines.length, 1)
  // 空正文行跳过
  assert.equal(parseAwlrc('[00:01.000]<0,10>   ').lines.length, 0)
})

test('findAwlrcLine 先按时间精确匹配，再按行号兜底', () => {
  const aw = parseAwlrc(REAL)
  assert.equal(findAwlrcLine(aw, 99, 2223)?.text, '词：諾然')
  assert.equal(findAwlrcLine(aw, 0, 999_999)?.text, '2026一定会幸福 (女声版) - 諾然') // 时间对不上 → 行号
  assert.equal(findAwlrcLine(aw, 1, undefined)?.text, '词：諾然')
  assert.equal(findAwlrcLine(aw, 99, undefined), undefined)
})

test('findAwlrcLine 传了正文就要求正文一致（防止错位后涂错行的字）', () => {
  const aw = parseAwlrc(REAL)
  // 行号兜底命中同一行 → 正常返回
  assert.equal(findAwlrcLine(aw, 1, undefined, '词：諾然')?.timeMs, 2223)
  // 行号兜底命中别的行 → 宁可退回逐行
  assert.equal(findAwlrcLine(aw, 1, undefined, '窗外的风吹得有点冷'), undefined)
  // 时间命中但正文不符（两套列表不同源）→ 同样退回
  assert.equal(findAwlrcLine(aw, 0, 2223, '不是这一行'), undefined)
  // 时间命中且正文一致 → 返回
  assert.equal(findAwlrcLine(aw, 0, 2223, '词：諾然')?.text, '词：諾然')
})

test('lineStyleKind：当前行扫光、唱过的行保持已唱色、之后的行才是普通色', () => {
  // 当前行
  assert.equal(lineStyleKind(3, 3, true), 'active')
  // 唱过的逐字行：不能退回普通色（真机上就是「扫光被擦掉」）
  assert.equal(lineStyleKind(2, 3, true), 'sung')
  assert.equal(lineStyleKind(0, 3, true), 'sung')
  // 还没唱到的行
  assert.equal(lineStyleKind(4, 3, true), 'idle')
  // 没有逐字信息的行：无论前后都按普通行处理
  assert.equal(lineStyleKind(2, 3, false), 'idle')
  // 还没开始唱（当前行是 -1）时全都是普通行
  assert.equal(lineStyleKind(0, -1, true), 'idle')
})

test('awlrcOf 只在字段确实是字符串时取值', () => {
  assert.equal(awlrcOf({ awlyric: '[00:01.000]<0,10>x' }), '[00:01.000]<0,10>x')
  assert.equal(awlrcOf({ awlyric: null }), '')
  assert.equal(awlrcOf({}), '')
  assert.equal(awlrcOf(null), '')
  assert.equal(awlrcOf(undefined), '')
})
