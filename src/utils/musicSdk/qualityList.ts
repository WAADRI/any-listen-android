/**
 * `global.lx.qualityList` 的构造。
 *
 * ## 形状：以**音源 id** 为键
 *
 * `global.lx.qualityList` 是 `LX.QualityList`，即
 * `Partial<Record<LX.Source, LX.Quality[]>>`（见 `src/types/common.d.ts`），
 * 也就是「音源 id → 该源支持的档位」。三处读取方都按这个形状取值：
 *
 * - `store/common/hook.ts` 的 `useAssertApiSupport`：`qualityList[source] != null`
 *   —— 取不到就把曲目**灰显**（`Mylist/MusicList/ListItem.tsx` 的 `opacity: 0.5`）
 * - `utils/tools.ts` 的 `assertApiSupport`（同上）
 * - `core/music/utils.ts` 的 `getPlayQuality`：`qualityList[musicInfo.source]`
 *
 * ## 踩过的坑：上游是**两层**，本 fork 只有一层
 *
 * 上游 `musicSdk.supportQuality` 是 `apiId → 音源表` 的两层结构
 * （`utils/musicSdk/api-source.js`：`supportQuality[api.id] = api.supportQualitys`，
 * 而 `api.supportQualitys` 本身就是 `Partial<Record<OnlineSource, Quality[]>>`），
 * 所以上游的赋值是 `global.lx.qualityList = supportQuality[apiId] ?? {}`。
 *
 * 本 fork 的注册表里 `supportQuality` **就是音源表本身**
 * （`{ anylisten: ['128k'] }`）。照抄上游那一行，等于把**音质数组**当成音源表
 * 发布出去：`qualityList['anylisten']` 恒为 `undefined`，于是
 * **整个曲库的曲目全部灰显、不可点**，而 `getMusicUrl` 其实完全正常 ——
 * 真机日志里 `qualityList全部键=["0"]` 就是这个错误（`['128k']` 的键是 `'0'`）。
 *
 * 类型检查救不了：注册表是 `.js`，`musicSdk.supportQuality` 在调用点被推断为
 * `any`，错误的下标取值不会报错；CI 也只跑单测与打包。
 *
 * 所以把「取音源表」这一步收进本函数，让**调用点不再对注册表取下标**，
 * 并由 `qualityList.test.ts` 同时覆盖返回值形状与调用点写法。
 */

/**
 * 用**单个音源**的音质档构造 `global.lx.qualityList`。
 *
 * 返回值一定是以 `sourceId` 为键的表；`qualitys` 为 `undefined` 时返回空表
 * （等价于「该源没有可用档位」，`assertApiSupport` 会判为不可用）。
 *
 * @param sourceId 音源 id（本 fork 只有 `anylisten`）
 * @param qualitys 该源支持的音质档，如 `['128k']`
 */
export const toQualityList = (sourceId: string, qualitys?: LX.Quality[]): LX.QualityList => {
  if (qualitys == null) return {}
  return { [sourceId]: qualitys } as LX.QualityList
}
