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

test('两个方向的播放页都按段渲染，并交给 WordLyricLine', () => {
  for (const file of [
    '../screens/PlayDetail/Vertical/Lyric.tsx',
    '../screens/PlayDetail/Horizontal/Lyric.tsx',
  ]) {
    const source = read(file)
    assert.match(source, /findAwlrcLine\(awlrc, lineNum, line\.time, line\.text\)/, `${file} 没有按行取逐字段（或丢了正文校验）`)
    assert.match(source, /kind === 'active' && awlrcLine\?\.segments\.length/, `${file} 没有把当前行交给逐字歌词渲染组件`)
    assert.match(source, /unplayColor=\{theme\['c-250'\]\}/, `${file} 的未唱色不再是 --color-250`)
    // 唱过的行与当前行同一套颜色（桌面版的 `.played`）：少了这条，扫光过行后会整行变灰
    assert.match(source, /lineStyleKind\(lineNum, activeLine, !!awlrcLine\?\.segments\.length\)/, `${file} 不再区分「当前行 / 唱过的行 / 未唱的行」`)
    assert.match(source, /if \(kind !== 'idle'\) return \[theme\['c-primary'\], theme\['c-primary-alpha-200'\], 1\]/, `${file} 唱过的行与当前行不再是同一套颜色`)
  }

  // 底栏只是一行普通文字：那里不做逐字（它常驻所有页面，重绘成本不划算）
  const bar = read('../components/player/PlayerBar/components/Status.tsx')
  assert.ok(!/useWordLyricProgress|awlrc/.test(bar), '底栏又接上逐字了')
})

test('逐字渲染组件：一层未唱、一层已唱，用会长的裁剪盒扫出来', () => {
  const component = read('../screens/PlayDetail/components/WordLyricLine.tsx')
  // 扫光：线性动画 + 时长来自该段自己的时长（对应桌面版 duration = 段时长 / rate）
  assert.match(component, /Animated\.timing\(clipWidth/, '扫光不再用定时动画驱动')
  assert.match(component, /easing:\s*Easing\.linear/, '扫光不是线性推进，会与桌面版不一致')
  assert.match(component, /duration:\s*Math\.max\(1,\s*remaining \/ wordLyricClock\.rate\)/, '扫光时长没有按「本段剩余时长 / 倍速」计算')
  assert.match(component, /sweepXAt\(/, '没有用时间轴算出该时刻的扫过位置')
  // 两层同一行文字：未唱层 + 已唱层的裁剪盒
  assert.match(component, /styles\.clip/, '缺少裁剪层')
  assert.match(component, /overflow:\s*'hidden'/, '裁剪层没有 overflow: hidden，扫光会整行露出来')
  // 一行放不下时退回逐段换色（折行时整行扫光会把第二行也点亮）
  assert.match(component, /totalWidth <= box\.width/, '缺少「一行放得下才用扫光」的判断')
  assert.match(component, /index < played \? playedColor : unplayColor/, '兜底渲染没有逐段换色')
})

test('兜底分支里也必须挂测量行（否则永远进不了扫光）', () => {
  const component = read('../screens/PlayDetail/components/WordLyricLine.tsx')
  // 真机踩过：段宽只有挂了 onLayout 才量得到，而扫光分支又要求先量到段宽才渲染。
  // 测量行如果只放在扫光分支里，两者互相等待 —— 表现是「一个字一个字换色，字内部不扫」。
  const fallbackStart = component.indexOf('if (!canSweep)')
  assert.ok(fallbackStart >= 0, '找不到兜底分支，本用例已失效')
  const sweepStart = component.indexOf('// 扫光：两层同一行文字')
  assert.ok(sweepStart > fallbackStart, '找不到扫光分支的分界，本用例已失效')
  const fallbackBody = component.slice(fallbackStart, sweepStart)
  assert.match(fallbackBody, /styles\.measure/, '兜底分支里没有测量行：段宽永远量不到，扫光分支永远不会渲染')
  assert.match(fallbackBody, /onSegmentLayout=\{handleSegmentLayout\}/, '兜底分支里的测量行没有挂测量回调')
})

test('逐字进度改用本地时钟 + 段边界定时器，不再按固定间隔轮询位置', () => {
  const hook = read('./hooks/useWordLyricProgress.ts')
  // 位置只在 play / pause / seek / 换行时读一次（对应桌面版 core/lyric.ts 的 getCurrentTime）
  assert.match(hook, /getPosition\(\)/, '逐字进度没有读本机播放位置')
  assert.match(hook, /wordLyricClock/, '没有使用本地时钟')
  assert.match(hook, /global\.app_event\.on\('setProgress'/, '拖进度条/恢复进度时逐字不会重新对齐')
  assert.match(hook, /AppState\.currentState === 'background'/, '后台时仍在排定时器')
  // 扫光必须与「行切换」用同一个歌词偏移，否则会比桌面歌词慢一个字（真机反馈）
  assert.match(hook, /lyricOffset/, '扫光没有加行切换用的歌词偏移')
  assert.match(hook, /positionAt\(now\) \+ lyricOffset - lineTimeMs/, '偏移没有加在「相对本行」的计时上')
  assert.match(read('../plugins/lyric.ts'), /offset: lyricOffset/, '行切换的偏移与扫光的偏移不是同一个常量')
  assert.ok(!/positionAt\(Date\.now\(\)\) - line\.timeMs/.test(read('../screens/PlayDetail/components/WordLyricLine.tsx')), '扫光组件仍在用没有偏移的计时')
  // 关键在于「只在段开始时醒一次」：任何固定间隔轮询都会把效果量化成网格并造成掉帧
  assert.ok(!/setInterval/.test(hook), '逐字进度又回到固定间隔轮询了（上一版就是因此生硬卡顿）')
  assert.ok(!/setInterval/.test(read('../screens/PlayDetail/components/WordLyricLine.tsx')), '扫光层又回到固定间隔轮询了')
})
