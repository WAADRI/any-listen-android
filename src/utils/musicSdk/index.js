/**
 * 本 fork 的音源注册表。
 *
 * ## 这个文件为什么是 `.js` 而不是 `.ts`
 *
 * 它沿用上游的路径与扩展名（`@/utils/musicSdk`），且**必须是纯 JavaScript**：
 * Metro 的 Babel 对 `.js` 文件**不做 TypeScript 类型擦除**，
 * 写类型标注会直接变成语法错误（曾经写成 `(x: string): x is T =>` 导致
 * `Unexpected token` 打包失败，而 lint 与单测都不会发现）。
 * 因此这里的类型信息一律用 JSDoc 表达。
 *
 * ## 与上游的差别
 *
 * 上游注册的是 kw / kg / tx / wy / mg 五个**第三方商业音乐平台**的音源
 * （约 240 个文件），并带一套跨源兜底逻辑。本 fork 只使用用户**自建**的
 * any-listen 服务器，所以这里只注册一个源。
 *
 * 目录里仍留有 `kw/`、`kg/` 等目录，但它们**已不被任何代码引用**，
 * 下一步会单独删除。之所以分两步：先让新链路跑通并验证，再删代码 ——
 * 否则一旦出问题，无法区分是「新链路写错了」还是「删错了」。
 *
 * ## 导出形状
 *
 * 与上游一致，因此所有 `import musicSdk from '@/utils/musicSdk'` 的调用点都不用改：
 * - `musicSdk[sourceId]` → 单个源对象
 * - `musicSdk.sources` → `[{ name, id }]`，被歌单页、热搜页遍历
 * - `musicSdk.supportQuality` → `Partial<Record<OnlineSource, Quality[]>>`
 *
 * ## 保留 findMusic / searchMusic 的理由
 *
 * 上游的 `findMusic` 是「这首歌取不到就去别的源碰运气」的兜底，
 * 它在 `core/music/utils.ts` 的取址失败分支里**仍在关键路径上**。
 * 单源情况下它只会返回空数组，调用方随即放弃兜底并抛出原始错误 ——
 * 这正是我们想要的行为（失败就明确失败，不要瞎猜）。
 */
import anylisten, { supportQualitys } from './anylisten'

const sources = [
  {
    // 显示名。UI 会优先查 i18n 的 `source_alias_<id>` / `source_real_<id>`，
    // 查不到才回落到这个名字。
    name: 'any-listen',
    id: 'anylisten',
  },
]

/** @type {Partial<Record<LX.OnlineSource, LX.Quality[]>>} */
const supportQuality = {
  anylisten: supportQualitys,
}

const musicSdk = {
  sources,
  anylisten,
  supportQuality,
}

export default musicSdk

/**
 * 「换个源再试」的兜底。单源情况下**按设计**返回空数组，见文件头说明。
 * @returns {Promise<unknown[]>}
 */
export const findMusic = async() => []

/**
 * 上游的跨源搜索聚合。单源情况下没有可聚合的对象。
 * @returns {Promise<unknown[]>}
 */
export const searchMusic = async() => []

