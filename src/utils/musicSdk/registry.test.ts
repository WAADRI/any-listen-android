/**
 * 音源注册表的契约检查。
 *
 * ## 这个文件要防的是什么
 *
 * 一次真实的启动崩溃：清理内置音源时删掉了 `musicSdk` 的 `init` 导出，
 * 但 `core/init/dataInit.ts` 仍在 `import { init as musicSdkInit }` 并调用。
 * import 得到 `undefined`，调用时抛
 *
 *     TypeError: undefined is not a function
 *
 * 而界面只弹一个「初始化失败」的对话框。这个错误**编译期看不见**
 * （Metro 对缺失的具名导入不报错），当时也没有任何用例 import 过该模块。
 *
 * ## 为什么用「静态文本检查」而不是直接 import
 *
 * 直接 `import musicSdk from './index.js'` 在 Node 侧会失败：
 * `index.js` 用目录形式导入适配器（`from './anylisten'`），
 * Metro 与 TS 的 bundler 解析都支持，但 Node 的 ESM 解析器在这种
 * 「目录 → .ts」的组合下会丢掉具名导出的链接，报
 * `does not provide an export named 'supportQualitys'`，
 * 而该导出**确实存在**（显式路径导入即可看到）。
 *
 * 这是测试环境的解析限制，不是应用缺陷 —— Metro 打包一切正常。
 * 与其为它维护解析钩子，不如把检查写成对**源码文本**的断言：
 * 它不依赖任何解析行为，且正好覆盖「调用点引用了不存在的导出」这个缺陷类别。
 *
 * ## 覆盖面
 *
 * - 注册表**实际导出**了哪些具名成员（从源码里解析 `export` 语句）
 * - 每个调用点 `import ... from '@/utils/musicSdk'` **要求**哪些具名成员
 * - 适配器必须提供界面直接调用的那些方法
 *
 * 映射：`anylisten` 是唯一音源，`sources` 里一旦新增，就需要在这里补齐对应实现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('../../', import.meta.url))
const REGISTRY = join(SRC, 'utils/musicSdk/index.js')
const ADAPTER = join(SRC, 'utils/musicSdk/anylisten/index.ts')

/** 递归收集 src 下的源码文件。 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full))
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** 解析注册表**实际导出**的具名成员。 */
function exportedNames(source: string): Set<string> {
  const names = new Set<string>()
  // export const x / export function x / export async function x / export let x
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1])
  }
  // export { a, b as c }
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim()
      if (!piece) continue
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(piece)
      names.add(asMatch ? asMatch[1] : piece)
    }
  }
  return names
}

/** 找出所有从注册表具名导入的调用点及其要求的具名成员。 */
function requiredNames(files: string[]): Array<{ file: string, names: string[] }> {
  const out: Array<{ file: string, names: string[] }> = []
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    // 只匹配**恰好**指向注册表本体的导入（排除 '@/utils/musicSdk/...' 子路径）。
    // 同时匹配两种写法：
    //   import { a } from '@/utils/musicSdk'
    //   import def, { a } from '@/utils/musicSdk'
    // 旧正则只认前者，于是 `core/music/utils.ts` 的
    // `import musicSdk, { findMusic } from '@/utils/musicSdk'` 一直没被扫到。
    // 这个漏洞是被「唯一使用 `import { searchMusic }` 的文件（换源弹窗）被删除」
    // 暴露出来的：消费者列表直接变空，触发了下面那条「本用例已失效」断言。
    const re = /import\s+(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*'@\/utils\/musicSdk'/g
    for (const m of source.matchAll(re)) {
      const names = m[1]
        .split(',')
        .map(part => part.trim())
        .filter(Boolean)
        // `x as y` 取原始名字 x（被导入的是 x）
        .map(part => (/^([A-Za-z_$][\w$]*)\s+as\s+/.exec(part)?.[1] ?? part))
        .filter(name => /^[A-Za-z_$][\w$]*$/.test(name))
      if (names.length) out.push({ file: file.slice(SRC.length).replace(/\\/g, '/'), names })
    }
  }
  return out
}

test('注册表导出了所有调用点要求的具名成员', () => {
  const exported = exportedNames(readFileSync(REGISTRY, 'utf8'))
  const consumers = requiredNames(collectSourceFiles(SRC))

  // 至少要能找到调用点，否则说明正则或目录结构变了，本用例已失效
  assert.ok(consumers.length > 0, '没有找到任何从 @/utils/musicSdk 具名导入的调用点，本用例已失效')

  const missing: string[] = []
  for (const { file, names } of consumers) {
    for (const name of names) {
      if (!exported.has(name)) missing.push(`${file} 导入的 ${name}`)
    }
  }

  assert.deepEqual(
    missing,
    [],
    `以下调用点导入了注册表没有导出的成员，运行时会得到 undefined 并在调用时崩溃：\n  ${missing.join('\n  ')}`,
  )
})

test('注册表仍然导出 findMusic（core/music/utils.ts 的取址兜底路径依赖）', () => {
  const exported = exportedNames(readFileSync(REGISTRY, 'utf8'))
  assert.ok(exported.has('findMusic'), 'findMusic 不再导出')
})

/**
 * 反向断言：`searchMusic` **不再**导出。
 *
 * 它唯一的消费者是「歌曲换源」弹窗（已随单源化删除）。若将来有人把多源
 * 能力加回来，这条会提醒他确认聚合搜索的调用点是否也要恢复。
 */
test('注册表不导出 searchMusic（跨源聚合只剩单源，且换源 UI 已删除）', () => {
  const exported = exportedNames(readFileSync(REGISTRY, 'utf8'))
  assert.ok(
    !exported.has('searchMusic'),
    '注册表又导出了 searchMusic：请确认是否真的存在消费它的调用点，并更新本断言',
  )
})

test('适配器导出界面直接调用所需的方法', () => {
  const source = readFileSync(ADAPTER, 'utf8')
  const exported = exportedNames(source)

  // 这些是 core/ 与 store/ 直接用的
  for (const name of ['musicSearch', 'songList', 'init', 'supportQualitys'] as const) {
    assert.ok(exported.has(name), `适配器没有导出 ${name}`)
  }
  // 默认导出必须带上玩家与歌单入口
  const defaultBlock = /\bexport default\s*\{([\s\S]*?)\n\}/.exec(source)
  assert.ok(defaultBlock, '找不到适配器的 export default 块')
  for (const name of ['getMusicUrl', 'getPic', 'getLyric', 'musicSearch', 'songList', 'init'] as const) {
    assert.ok(
      new RegExp(`\\b${name}\\b`).test(defaultBlock[1]),
      `适配器的默认导出缺少 ${name}`,
    )
  }
})

test('注册表里 sources 的每个 id 都在注册表上挂了同名实现', () => {
  const source = readFileSync(REGISTRY, 'utf8')
  // sources 里的 id
  const ids = [...source.matchAll(/^\s*id:\s*'([^']+)'/gm)].map(m => m[1])
  assert.ok(ids.length > 0, '没有从注册表源码里解析出任何 source id')

  // 注册表对象字面量里必须出现同名键（musicSdk[source.id] 才能取到实现）
  const objectBlock = /const musicSdk = \{([\s\S]*?)\n\}/.exec(source)
  assert.ok(objectBlock, '找不到 musicSdk 对象字面量')
  for (const id of ids) {
    assert.ok(
      new RegExp(`\\b${id}\\b`).test(objectBlock[1]),
      `sources 里有 ${id}，但 musicSdk 对象里没有挂 ${id}`,
    )
  }
})

/**
 * 反向断言：`init` **不再**导出。
 *
 * dataInit.ts 曾因调用它而崩溃。将来若有人把 init 加回来，
 * 这条会提醒他确认 dataInit 的调用是否也要恢复。
 */
test('注册表不导出 init（dataInit.ts 曾因调用已删除的 init 而崩溃）', () => {
  const exported = exportedNames(readFileSync(REGISTRY, 'utf8'))
  assert.ok(
    !exported.has('init'),
    '注册表又导出了 init：请确认 core/init/dataInit.ts 的调用是否需要同步恢复，并更新本断言',
  )
})
