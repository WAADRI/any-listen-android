/**
 * Node 的 ESM 解析钩子：把**无扩展名**的相对导入映射到 `.ts` 源文件。
 *
 * ## 为什么需要它
 *
 * 生产代码用 `import { sha256Hex } from './sha256'` 这种无扩展名写法 ——
 * 这是 Metro（React Native 打包器）与 TS 的 `moduleResolution: bundler` 的
 * 标准写法，全仓库一致，不该为了跑测试而改动它。
 *
 * 但 Node 的 ESM 解析器**要求显式扩展名**，遇到 `./sha256` 会直接
 * `ERR_MODULE_NOT_FOUND`。于是协议层那些刻意写成「不依赖 React Native、
 * 可被 node --test 直接验证」的模块就跑不起来。
 *
 * 这个钩子只影响 Node 侧的解析，不进入应用包，也不改生产代码的写法。
 *
 * 用法：
 *   node --import ./tools/tsResolver.mjs --test "src/utils/anylisten/*.test.ts"
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

/** 依次尝试的候选扩展名。 */
const CANDIDATE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.jsx']

function tryResolveExtensionless(specifier, context) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null
  // 已经有扩展名的（含 .test.ts 这类多段后缀）不处理
  if (/\.[a-zA-Z0-9]+$/.test(specifier)) return null

  const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd()
  const baseUrl = new URL(specifier, pathToFileURL(parentPath))
  for (const ext of CANDIDATE_EXTENSIONS) {
    const candidate = new URL(baseUrl.href + ext)
    if (existsSync(fileURLToPath(candidate))) {
      // 不要指定 format：指定成 'module' 会让 Node 跳过 TypeScript 的类型擦除，
      // 把 .ts 当普通 JS 解析，于是 `input: string` 直接报 SyntaxError。
      // 交给 Node 依据扩展名自行判定格式。
      return { url: candidate.href, shortCircuit: true }
    }
  }
  return null
}

/**
 * Node >= 22.15 / 24 的同步解析钩子。
 * 必须通过 `registerHooks` 注册，仅仅导出这个函数是不够的。
 */
export function resolveSync(specifier, context, nextResolve) {
  return tryResolveExtensionless(specifier, context) ?? nextResolve(specifier, context)
}

/** 异步解析钩子，供 `module.register()` 使用。 */
export async function resolve(specifier, context, nextResolve) {
  return tryResolveExtensionless(specifier, context) ?? nextResolve(specifier, context)
}

/**
 * 自我注册。
 *
 * 只导出 `resolve` 而不注册的话，钩子**不会**被应用到主模块图，
 * 于是 `client.ts` 里的 `./sha256` 依然解析失败 —— 这正是第一版的问题。
 * 这里两种 API 都试：Node 24 用同步的 `registerHooks`，旧版本回退到 `register`。
 */
try {
  const { registerHooks } = await import('node:module')
  if (typeof registerHooks === 'function') {
    registerHooks({ resolve: resolveSync })
  } else {
    register(import.meta.url)
  }
} catch {
  register(import.meta.url)
}

