/**
 * any-listen 服务端返回的资源地址解析。
 *
 * 服务端有两种「看起来像 URL 但不能直接用」的返回值，**两种都会真实出现**：
 *
 * | 服务端返回 | 真实值 | 直接用会怎样 |
 * |---|---|---|
 * | 虚拟公共路径 | `al-ps-host:/public/medias/<sha256>.mp3` | 拼成 `https://host/al-ps-host:/public/...` → 404 |
 * | 同源相对路径 | `./api/p_static/<sha256>.jpeg` | 交给图片加载器 → FileNotFoundException |
 *
 * 关键语义：虚拟标记是被**替换**成 host，不是拼在 host 后面。服务端
 * `buildRealPublicPath` 的实现就是一句 `virtualPath.replace(VIRTUAL_PROTOCOL, host)`
 * （`packages/shared/common/tools.ts`），Web 端的 `buildUrl()` 也是先做这一步替换
 * 才考虑代理。
 *
 * 本模块刻意不依赖 React Native，因此可以直接用 `node --test` 跑真实单测。
 */

/** 服务端虚拟协议的标记，来自 `packages/shared/common/tools.ts` 的 `VIRTUAL_PROTOCOL`。 */
export const VIRTUAL_PROTOCOL = 'al-ps-host:'

/** 把 base 规整成不带末尾斜杠的形式，便于做前缀替换。 */
const trimTrailingSlash = (base: unknown): string =>
  typeof base === 'string' ? base.replace(/\/+$/, '') : ''

/**
 * 把服务端返回的资源地址解析成可直接请求的绝对 URL。
 *
 * 已是 http(s) 绝对地址的原样返回（有些部署/代理会直接给出绝对地址）。
 * 其余情况返回 `null`，表示**没有**可用的地址 —— 调用方应当据此显示占位图标，
 * 而不是把一个解析不了的字符串交给图片/音频层（那正是历史上封面坏掉的表现）。
 */
export function resolveServerUrl(raw: unknown, serverUrl: string): string | null {
  if (typeof raw !== 'string') return null
  const url = raw.trim()
  if (!url) return null

  // 虚拟标记必须整体替换成 host。
  // 注意不能用 startsWith + slice 之外的花样：标记出现在字符串**开头**，
  // 而且后面紧跟一个 '/'，所以替换结果天然是 "host" + "/public/..."。
  if (url.startsWith(VIRTUAL_PROTOCOL)) {
    const base = trimTrailingSlash(serverUrl)
    if (!base) return null
    return base + url.slice(VIRTUAL_PROTOCOL.length)
  }

  // 同源相对路径：以 / 开头，或以 ./ 或 ../ 开头。
  if (url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) {
    const base = trimTrailingSlash(serverUrl)
    if (!base) return null
    // 逐个吃掉开头的 ./ 与 ../，不要用单次正则替换：
    // '..'.replace(/^\.\//, '') 不匹配，会把 '..' 原样留在结果里，
    // 产出 'https://host/../api/x' 这种畸形地址。
    let rest = url
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (rest.startsWith('../')) {
        rest = rest.slice(3)
        continue
      }
      if (rest.startsWith('./')) {
        rest = rest.slice(2)
        continue
      }
      break
    }
    const path = rest.startsWith('/') ? rest : '/' + rest
    return base + path
  }

  // 已经是绝对地址（http/https），原样返回。
  if (/^https?:\/\//i.test(url)) return url

  // 其余（data:、file:// 等）也原样放过，交给 RN 的图片层判断。
  // 这类值不是服务端资源地址，不应当被当成错误。
  if (/^(data|file|content|blob):/i.test(url)) return url

  return null
}

/**
 * 判断一个地址是否值得作为 `artwork` 交给 react-native-track-player。
 *
 * lx 原有实现是 `/^(https?:\/\/.+|\/.+)/`，它对 any-listen 的两种返回值**全部拒绝**
 * （`al-ps-host:` 不以 http 开头也不以 / 开头；`./api/...` 以 `.` 开头），
 * 表现是通知栏/锁屏封面静默消失。
 *
 * 正确做法是先解析再用：解析成功即为可用。
 */
export function isUsableArtworkUrl(resolved: string | null): resolved is string {
  return typeof resolved === 'string' && resolved.length > 0
}
