/**
 * 「音源门禁」的契约检查：所有在线资源请求都必须先等音源就绪。
 *
 * ## 这个文件要防的是什么
 *
 * 真机复现过的缺陷：开启「记住播放进度」后，播放到一半退出应用，下次打开时
 * **歌词一直显示「歌词获取失败」**，而封面与播放都正常。
 *
 * 链路是这样的：
 *
 * 1. 恢复播放时 `core/player/player.ts` 的 `handleRestorePlay` 先取歌词、之后才取播放地址；
 *    也就是说**歌词是启动后第一个发出的 RPC**；
 * 2. 此刻 any-listen 的 socket 一般还在 `connecting`，而
 *    `AnyListenSession.call()` 在未连接时**立即 reject**（`连接未就绪（当前状态 connecting）`），
 *    不排队、不重试；
 * 3. 取歌词的 catch 把状态文字设成「歌词获取失败」，并且此后再无重试。
 *
 * 为什么只有歌词坏：`handleGetOnlineMusicUrl` 开头有一句
 * `if (!await global.lx.apiInitPromise[0]) throw new Error('source init failed')`
 * —— 它会等门禁（门禁在 any-listen 连上时才落定为 true），所以取址慢一步、正好躲过竞争。
 * 歌词与封面当初漏了这句，于是谁先发请求谁就失败。
 *
 * 这类缺陷**单测与打包都发现不了**（要真机 + 正确的时序），所以这里把
 * 「发 RPC 之前必须先等门禁」写成源码级断言，防止有人在新增/修改在线资源路径时再漏一次。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FILE = fileURLToPath(new URL('./utils.ts', import.meta.url))
const SOURCE = readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n')

const HANDLERS = [
  'handleGetOnlineMusicUrl',
  'handleGetOnlinePicUrl',
  'handleGetOnlineLyricInfo',
] as const

for (const name of HANDLERS) {
  test(`${name} 在发起 RPC 之前先等音源门禁`, () => {
    const start = SOURCE.indexOf(`export const ${name} = async`)
    assert.ok(start >= 0, `找不到 ${name}，本用例已失效`)

    const body = SOURCE.slice(start)
    // 在线资源路径都是「先造 reqPromise，再 .then/.catch」的写法；
    // 门禁必须出现在这一步之前，否则请求会赶在连接建立前发出去。
    const reqIdx = body.indexOf('let reqPromise')
    assert.ok(reqIdx >= 0, `${name} 里找不到 \`let reqPromise\`，本用例的定位方式已失效`)

    const beforeRpc = body.slice(0, reqIdx)
    assert.ok(
      /await global\.lx\.apiInitPromise\[0\]/.test(beforeRpc),
      `${name} 没有在发 RPC 之前等音源门禁：任何在连接建立前到达的请求都会立即失败`
      + '（真机上表现为「歌词获取失败」且不再重试）。请加上：\n'
      + "  if (!await global.lx.apiInitPromise[0]) throw new Error('source init failed')",
    )
  })
}
