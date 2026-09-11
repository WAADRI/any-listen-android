/**
 * 本 fork 的音源注册表。
 *
 * ## 与上游的差别
 *
 * 上游注册的是 kw / kg / tx / wy / mg 五个**第三方商业音乐平台**的音源
 * （约 240 个文件），并带一套跨源兜底逻辑。本 fork 只使用用户**自建**的
 * any-listen 服务器，所以这里只注册一个源。
 *
 * 目录里仍留有 `kw/`、`kg/` 等目录，但它们**已不被任何代码引用**
 * （本文件不再 import），下一步会单独删除。之所以分两步：先让新链路跑通并验证，
 * 再删代码 —— 否则一旦出问题，无法区分是「新链路写错了」还是「删错了」。
 *
 * ## 导出形状
 *
 * 与上游 `index.js` 保持一致，因此所有 `import musicSdk from '@/utils/musicSdk'`
 * 的调用点都不需要改动：
 *
 * - `musicSdk[sourceId]` → 单个源对象
 * - `musicSdk.sources` → `[{ name, id }]`，被歌单页、热搜页遍历
 * - `musicSdk.supportQuality` → `Partial<Record<OnlineSource, Quality[]>>`
 *
 * ## 保留 findMusic / searchMusic 的理由
 *
 * 上游的 `findMusic` 是「这首歌取不到就去别的源碰运气」的兜底，
 * 它在 `core/music/utils.ts` 的取址失败分支里**仍在关键路径上**。
 * 单源情况下它只会返回空数组，调用方随即放弃兜底并抛出原始错误 ——
 * 这正是我们想要的行为（失败就明确失败，不要去猜别的源）。
 * 保留这个函数而不是拆调用点，是为了不动播放链路。
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

const supportQuality: Partial<Record<LX.OnlineSource, LX.Quality[]>> = {
  anylisten: supportQualitys,
}

const musicSdk = {
  sources,
  anylisten,
  supportQuality,
}

export default musicSdk

/** 初始化所有源。返回的 promise 会被 `global.lx.apiInitPromise` 使用。 */
export const init = () => {
  const tasks: Array<Promise<unknown>> = []
  for (const source of sources) {
    const sm = (musicSdk as unknown as Record<string, { init?: () => Promise<unknown> }>)[source.id]
    if (sm?.init) tasks.push(sm.init())
  }
  return Promise.all(tasks)
}

/** 判断一个标识是否是本 fork 支持的音源。 */
export const isSupportedSource = (source: string): source is LX.OnlineSource =>
  sources.some((s) => s.id === source)

/**
 * 「换个源再试」的兜底。单源情况下**按设计**返回空数组。
 * 见文件头说明。
 */
export const findMusic = async(_musicInfo: unknown): Promise<unknown[]> => []

/** 上游的跨源搜索聚合。单源情况下没有可聚合的对象。 */
export const searchMusic = async(_params: unknown): Promise<unknown[]> => []
