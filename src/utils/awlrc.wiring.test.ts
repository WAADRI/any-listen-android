/**
 * 逐字歌词（any-listen 的 `awlyric`）链路的契约检查。
 *
 * ## 这个文件要防的是什么
 *
 * 逐字歌词从服务端一路走到屏幕，要经过四个地方：
 *
 * 1. 适配层把 `awlyric` 映射成 lx 的 `lxlyric`（`musicSdk/anylisten/index.ts`）
 *    → `playerState.musicInfo.lxlrc`（`core/player/player.ts`）；
 * 2. `core/lyric.ts` 的 `setLyric()` 把它**作为第 4 个参数**交给歌词插件；
 * 3. `plugins/lyric.ts` 的 `setLyric()` 用 `parseAwlrc()` 解析并广播；
 * 4. 界面（播放页两个方向 + 底栏）取当前行、按本机播放位置逐段上色。
 *
 * 这条链**任何一节断掉都不会报错**：解析器本身有单测、界面照旧显示整行歌词，
 * 只是逐字效果静默消失。历史教训是「功能看起来实现了，却一次都没生效，且不报错」
 * ——所以这里把每一节写成源码级断言，改坏了立刻红。
 *
 * 解析规则本身（段相对本行、零时长段、逐行回退等）由 `src/utils/awlrc.test.ts`
 * 用真实服务端数据覆盖，这里只管「有没有接上」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')

const ADAPTER = read('./musicSdk/anylisten/index.ts')
const MUSIC_UTILS = read('../core/lyric.ts')
const PLUGIN = read('../plugins/lyric.ts')

test('适配层仍把 awlyric 映射到 lx 的逐字歌词字段', () => {
  // 界面拿到的逐字歌词唯一的来源就是这个映射；字段名换成别的（例如 tlyric）
  // 会让整条链静默失效
  assert.match(
    ADAPTER,
    /lxlyric:\s*typeof info\.awlyric === 'string' && info\.awlyric \? info\.awlyric : null/,
    '适配层不再把 info.awlyric 映射到 lxlyric，逐字歌词会整条丢失',
  )
})

test('core/lyric.ts 把 lxlrc 当作歌词的第 4 个参数传下去', () => {
  const start = MUSIC_UTILS.indexOf('export const setLyric = async')
  assert.ok(start >= 0, '找不到 core/lyric.ts 的 setLyric，本用例已失效')
  const body = MUSIC_UTILS.slice(start)
  assert.match(
    body,
    /handleSetLyric\(playerState\.musicInfo\.lrc,\s*tlrc,\s*rlrc,\s*playerState\.musicInfo\.lxlrc/,
    'core/lyric.ts 不再把 playerState.musicInfo.lxlrc 传给歌词插件，逐字歌词到不了界面',
  )
  // 停止播放时必须把它一起清掉，否则下一首没有逐字歌词时会拿旧数据涂色
  assert.match(MUSIC_UTILS, /handleSetLyric\(''\)/, 'stop() 不再清空歌词，旧的逐字歌词会残留')
})

test('plugins/lyric.ts 用 parseAwlrc 解析并对外广播', () => {
  const start = PLUGIN.indexOf('export const setLyric = (')
  assert.ok(start >= 0, '找不到 plugins/lyric.ts 的 setLyric，本用例已失效')
  const body = PLUGIN.slice(start, PLUGIN.indexOf('export const setPlaybackRate'))
  assert.match(body, /parseAwlrc\(awlrc\)/, 'plugins/lyric.ts 不再解析逐字歌词')
  assert.match(body, /notifyAwlrc\(\)/, 'plugins/lyric.ts 解析了但不通知界面，界面永远拿不到')
  assert.match(PLUGIN, /export const useAwlrc = \(\)/, '缺少 useAwlrc 钩子，界面无从订阅')
})

test('两个方向的播放页与底栏都按段上色', () => {
  for (const file of [
    '../screens/PlayDetail/Vertical/Lyric.tsx',
    '../screens/PlayDetail/Horizontal/Lyric.tsx',
  ]) {
    const source = read(file)
    assert.match(source, /useWordLyricProgress\(/, `${file} 没有接入逐字进度`)
    assert.match(source, /findAwlrcLine\(awlrc, lineNum, line\.time, line\.text\)/, `${file} 没有按行取逐字段（或丢了正文校验）`)
    assert.match(source, /index < played \? colors\[0\] : theme\['c-250'\]/, `${file} 没有逐段上色`)
  }

  const bar = read('../components/player/PlayerBar/components/Status.tsx')
  assert.match(bar, /useWordLyricProgress\(/, '底栏没有接入逐字进度')
  assert.match(bar, /findAwlrcLine\(awlrc, line, undefined, text\)/, '底栏没有按行取逐字段（或丢了正文校验）')
  assert.match(bar, /index < played \? theme\['c-primary'\]/, '底栏没有逐段上色')
})

test('逐字进度只在当前行轮询本机播放位置', () => {
  const hook = read('./hooks/useWordLyricProgress.ts')
  // 位置必须是本机播放位置：服务端不参与播放进度（见 AGENTS.md 的架构定位）
  assert.match(hook, /getPosition\(\)/, '逐字进度没有读本机播放位置')
  assert.match(hook, /playerState\.isPlay/, '暂停时仍在轮询，白白唤醒')
  assert.match(hook, /AppState\.currentState === 'background'/, '后台时仍在轮询')
  assert.match(hook, /global\.app_event\.on\('setProgress'/, '拖进度条/恢复进度时逐字不会跟着走')
})
