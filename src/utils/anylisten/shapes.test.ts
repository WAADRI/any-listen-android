/**
 * 服务端返回**形状**的契约检查。
 *
 * ## 这个文件要防的是什么
 *
 * 一次真实的、且非常隐蔽的缺陷：歌单详情永远是空的。
 * `songList.ts` 里写成
 *
 *     const tracks = Array.isArray(result?.list) ? result.list : []
 *
 * 而 `getListMusics` 返回的是**裸数组**，不是 `{ list: [...] }` 信封。
 * 关键在于：**在数组上读一个不存在的属性不会报错**，只会得到 `undefined`，
 * 于是 `Array.isArray(undefined)` 为假、静默退化成空数组。
 *
 * 这类错误有三个「看不见」：
 *
 * 1. **TypeScript 拦不住** —— `result?.list` 在数组类型上是合法的属性访问；
 * 2. **编译与打包不报错** —— 没有任何静态错误；
 * 3. **连不上时才暴露** —— 只有真的连着服务器点进歌单，才发现里面空的。
 *
 * 而且同一个坑我已经踩过两次（第一次是把 `getAllUserLists` 的
 * `{ defaultList, loveList, lastPlayList, userList }` 当成 `result.list` 读）。
 * 所以这里把每个方法的返回形状**写成断言**，让形状本身成为被测试的对象。
 *
 * 运行方式：`npm test`（用 tools/tsResolver.mjs 解析 .ts）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { AnyListenMusicList, AnyListenMyAllList } from './types.ts'

const SRC = fileURLToPath(new URL('../../', import.meta.url))

/**
 * 形状类型断言：只在**编译期**存在，运行时是空操作。
 *
 * 它的价值在于：如果将来有人把 `AnyListenMusicList` 改成
 * `{ list: [...] }`，下面的赋值就会编译失败，从而逼他同时检查调用点。
 */
type AssertAssignable<To, From extends To> = From

test('getListMusics 的返回是裸数组（不是 { list } 信封）', () => {
  // 这个赋值就是断言：数组必须能赋给 AnyListenMusicList
  const bare: AssertAssignable<AnyListenMusicList, Array<never>> = []
  assert.ok(Array.isArray(bare))
  // 显式记录「不能这样读」，防止有人改回去
  const wrong = (bare as unknown as { list?: unknown }).list
  assert.equal(wrong, undefined, '裸数组上不存在 list 属性 —— 这正是当初静默返回空的原因')
})

test('getAllUserLists 的返回是四个字段的对象，用户歌单在 userList 里', () => {
  const empty: AnyListenMyAllList = {
    defaultList: [],
    loveList: [],
    lastPlayList: [],
    userList: [],
  }
  assert.equal(Array.isArray(empty), false, 'getAllUserLists 不是数组')
  assert.ok(Array.isArray(empty.userList), 'userList 必须是数组')
  // 关键：没有 `list` 这个键。早期按 result.list 读，所以永远是空的。
  assert.equal((empty as unknown as { list?: unknown }).list, undefined)
})

/**
 * 源码级检查：`songList.ts` 不得再对 `getListMusics` 的结果取 `.list`。
 *
 * 形状类型断言只能证明「类型没写错」，证明不了「调用点没读错」——
 * 因为 `result?.list` 语法合法、类型也合法（属性访问不报错）。
 * 所以这里直接检查调用点，把它钉死。
 */
test('songList.ts 不再以 .list 读取 getListMusics 的结果', () => {
  const source = readFileSync(SRC + 'utils/musicSdk/anylisten/songList.ts', 'utf8')

  // 找 getListMusics 的调用点及其后两行，确认没有 .list 读取
  const callIdx = source.indexOf('await getListMusics(')
  assert.ok(callIdx >= 0, '没有找到 getListMusics 的调用点，本用例已失效')

  // 取出调用点之后的代码块（到下一个空行为止），检查里面有没有 `.list`
  const after = source.slice(callIdx)
  const blockEnd = after.indexOf('\n\n')
  const block = blockEnd >= 0 ? after.slice(0, blockEnd) : after
  assert.ok(
    !/\.list\b/.test(block.replace(/\/\/.*$/gm, '')),
    `getListMusics 的返回值是裸数组，读取 .list 会静默得到 undefined：\n${block}`,
  )
})
