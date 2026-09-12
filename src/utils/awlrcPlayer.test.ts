import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AwlrcClock, lineEndAt, nextBoundaryAt, sweepXAt } from './awlrcPlayer'
import { parseAwlrc } from './awlrc'

// 真实服务端数据里的一行（`tools/ws-dump-awlrc.mjs`）：`2026 我一定会幸福的`
// <0,467>2026 <467,227>我<1252,169>一<1421,142>定<1563,132>会<1695,140>幸<1835,115>福<1950,103>的
const REAL = `[00:04.755]<0,467>2026 <467,227>我<1252,169>一<1421,142>定<1563,132>会<1695,140>幸<1835,115>福<1950,103>的`
const LINE = parseAwlrc(REAL).lines[0]
const SEGS = LINE.segments
// 假设每段宽度 = 20px（单测只关心「位置映射」这件事，与真实字体无关）
const ENDS = SEGS.map((_, index) => (index + 1) * 20)

test('sweepXAt：段内线性推进，段与段之间的空隙停住', () => {
  // 第 0 段 <0,467>：0ms 在起点，233ms 到一半，467ms 到该段末尾
  assert.equal(sweepXAt(SEGS, ENDS, -100), 0)
  assert.equal(sweepXAt(SEGS, ENDS, 0), 0)
  assert.equal(sweepXAt(SEGS, ENDS, 233.5), 10)
  assert.equal(sweepXAt(SEGS, ENDS, 467), 20)
  // 空隙：467+227=694 到 1252 之间不动（桌面上就是没有动画在跑）。
  // 注意 694 之前第二段还在唱，所以 700ms 时扫过位置已经是第二段的末尾
  assert.equal(sweepXAt(SEGS, ENDS, 700), 40)
  assert.equal(sweepXAt(SEGS, ENDS, 1251), 40)
  // 第 2 段从 1252 开始（起点像素 = 前一段末尾 40）
  assert.equal(sweepXAt(SEGS, ENDS, 1252), 40)
  assert.equal(sweepXAt(SEGS, ENDS, 1252 + 84.5), 50)
  // 全部唱完 → 落在最后一个像素位置
  assert.equal(sweepXAt(SEGS, ENDS, 10_000), SEGS.length * 20)
})

test('sweepXAt：零时长段到点即整段扫完', () => {
  const segs = [
    { text: 'a', startMs: 0, durationMs: 100 },
    { text: '：', startMs: 100, durationMs: 0 },
    { text: 'b', startMs: 100, durationMs: 100 },
  ]
  const ends = [10, 20, 30]
  assert.equal(sweepXAt(segs, ends, 99), 9.9)
  // 100ms：零时长段直接算已唱，并进入 b 的起点
  assert.equal(sweepXAt(segs, ends, 100), 20)
  assert.equal(sweepXAt(segs, ends, 150), 25)
  assert.equal(sweepXAt(segs, ends, 200), 30)
})

test('sweepXAt：没有任何段时恒为 0', () => {
  assert.equal(sweepXAt([], [], 1234), 0)
  // 宽度还没测量完（ends 为空）也不会炸，退化成 0
  assert.equal(sweepXAt(SEGS, [], 500), 0)
})

test('nextBoundaryAt：给出下一段的开始时刻，没有下一段则 null', () => {
  assert.equal(nextBoundaryAt(SEGS, -100), 0)
  assert.equal(nextBoundaryAt(SEGS, 0), 467)
  assert.equal(nextBoundaryAt(SEGS, 467), 1252)
  assert.equal(nextBoundaryAt(SEGS, 1252), 1421)
  const last = SEGS[SEGS.length - 1].startMs
  assert.equal(nextBoundaryAt(SEGS, last), null)
  assert.equal(nextBoundaryAt([], 0), null)
})

test('lineEndAt：最后一段的结束时刻', () => {
  assert.equal(lineEndAt(SEGS), 1950 + 103)
  assert.equal(lineEndAt([]), 0)
})

test('AwlrcClock：播放时自己走，暂停后冻结，恢复时按给定位置重新起表', () => {
  const clock = new AwlrcClock()
  // 还没播放：位置就是锚点
  clock.resync(10_000, 1000)
  assert.equal(clock.positionAt(1500), 10_000)
  assert.equal(clock.isPlay, false)

  // 播放：墙钟走 1s，位置走 1s
  clock.setPlay(true, 1000, 10_000)
  assert.equal(clock.positionAt(1500), 10_500)
  assert.equal(clock.positionAt(4000), 13_000)

  // 倍速 2：墙钟 1s → 位置 2s
  clock.setRate(2, 4000)
  assert.equal(clock.positionAt(4000), 13_000)
  assert.equal(clock.positionAt(5000), 15_000)

  // 暂停：位置冻结在停表那一刻，之后墙钟再走也不动
  clock.setPlay(false, 5000, 15_000)
  assert.equal(clock.positionAt(9999), 15_000)

  // 恢复播放：必须用播放器的真实位置重新锚定（这里模拟「暂停期间用户拖了进度」）
  // 注意倍速还是上面的 2，所以墙钟 500ms 位置走 1000ms
  clock.setPlay(true, 9000, 1_000)
  assert.equal(clock.positionAt(9000), 1_000)
  assert.equal(clock.positionAt(9500), 2_000)
})

test('AwlrcClock：倍速非法值退化为 1，seek 到更早的位置也照常', () => {
  const clock = new AwlrcClock()
  clock.setPlay(true, 0, 60_000)
  clock.setRate(0, 0)
  assert.equal(clock.rate, 1)
  assert.equal(clock.positionAt(1000), 61_000)
  // 往回拖：位置立刻回到新锚点
  clock.resync(2_000, 2000)
  assert.equal(clock.positionAt(2000), 2_000)
  assert.equal(clock.positionAt(3000), 3_000)
})

test('时间轴与解析器的时间基准一致：段的 startMs 相对本行', () => {
  // 行时间是 4755ms，段 <0,467> 覆盖 [0,467)，末段 <1950,103> 到 2053ms
  assert.equal(LINE.timeMs, 4755)
  assert.equal(SEGS[0].startMs, 0)
  assert.equal(SEGS[SEGS.length - 1].startMs + SEGS[SEGS.length - 1].durationMs, 2053)
  // 「本行唱完的绝对时刻」= 行时间 + 末段结束
  assert.equal(LINE.timeMs + lineEndAt(SEGS), 6808)
})
