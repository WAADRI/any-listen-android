/**
 * `global.lx.qualityList` 形状的回归测试。
 *
 * ## 这个文件要防的是什么
 *
 * 真机现象：**整个曲库的曲目在列表里全部灰显、点不动**（`opacity: 0.5`），
 * 而播放本身完全正常。根因是 `core/apiSource.ts` 照抄了上游的
 * `global.lx.qualityList = musicSdk.supportQuality[apiId] ?? {}`：
 * 上游的 `supportQuality` 是 `apiId → 音源表` 的两层结构，
 * 本 fork 的注册表只有一层，于是发布出去的是**音质数组** `['128k']`，
 * `qualityList['anylisten']` 恒为 `undefined`。
 *
 * 真机日志（决定性证据，`Object.keys(['128k'])` 是 `['0']`）：
 *
 *     [anylisten] 曲目被判定为不可播放：source="anylisten"
 *       该源的音质档=undefined qualityList全部键=["0"]
 *
 * 这个错误**类型检查看不见**（注册表是 `.js`，调用点拿到 `any`），
 * 所以必须由单测钉住：既钉返回值形状，也钉调用点的写法。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { toQualityList } from './qualityList'

const API_SOURCE = fileURLToPath(new URL('../../core/apiSource.ts', import.meta.url))
const REGISTRY = fileURLToPath(new URL('./index.js', import.meta.url))

test('发布的 qualityList 以音源 id 为键，而不是音质数组本身', () => {
  const list = toQualityList('anylisten', ['128k'])

  assert.deepEqual(list, { anylisten: ['128k'] })
  assert.deepEqual(list['anylisten'], ['128k'])
  // 回归：曾经发布的是 `['128k']`，此时 `qualityList['anylisten']` 是 undefined，
  // 读取方（useAssertApiSupport / assertApiSupport / getPlayQuality）全部判为不可用
  assert.ok(!Array.isArray(list), 'qualityList 不能是数组：读取方一律按 qualityList[source] 取值')
  assert.equal(Object.keys(list).length, 1)
})

test('未声明档位的音源发布空表，而不是 undefined', () => {
  const list = toQualityList('anylisten', undefined)

  assert.deepEqual(list, {})
  assert.notEqual(list, undefined)
  // 空表下 assertApiSupport 会判为不支持 —— 这是期望行为（该源确实没有档位）
  assert.equal(list['anylisten'], undefined)
})

test('调用点用 toQualityList 构造，且不再对 supportQuality 直接取下标', () => {
  const source = readFileSync(API_SOURCE, 'utf8')

  assert.match(
    source,
    /global\.lx\.qualityList\s*=\s*toQualityList\(/,
    'apiSource.ts 必须通过 toQualityList 发布 qualityList',
  )
  assert.doesNotMatch(
    source,
    /global\.lx\.qualityList\s*=\s*musicSdk\.supportQuality\s*\[/,
    '不能照抄上游的 supportQuality[apiId]：本 fork 的注册表只有一层，会发布音质数组本身',
  )
})

/**
 * 注册表那一层必须与 `toQualityList` 的第二个参数匹配：
 * `supportQuality[apiId]` 要能取出**音质数组**。
 */
test('注册表的 supportQuality 是「音源 id → 音质数组」', () => {
  const source = readFileSync(REGISTRY, 'utf8')
  const block = /const supportQuality = \{([\s\S]*?)\n\}/.exec(source)

  assert.ok(block, '找不到注册表的 supportQuality 对象字面量')
  assert.match(
    block[1],
    /^\s*anylisten:\s*supportQualitys\s*,?\s*$/m,
    'supportQuality 必须把适配器的 supportQualitys 数组直接挂在音源 id 下（一层结构）',
  )
})
