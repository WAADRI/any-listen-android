// import { setUserApi as setUserApiAction } from '@renderer/utils/ipc'
import musicSdk from '@/utils/musicSdk'
import { updateSetting } from './common'
import settingState from '@/store/setting/state'
import { destroyUserApi, setUserApi } from './userApi'

/**
 * 当前这次初始化所用的 promise。
 *
 * 放在模块级而不是闭包里：`restartAnyListen()` 会在**运行中**替换它
 * （用户改了服务器地址 / 密码、或清空数据后重新配置），门禁必须按**最新**的
 * 那个来落定，否则会拿旧的失败结果一直卡着。
 */
let currentInitPromise: Promise<unknown> | undefined

/**
 * 替换「门禁依据的初始化 promise」并重新装填门禁。
 *
 * 重连场景必须走这里：如果只调 `rearmApiGate()`，它会拿**启动时**那个
 * 已经失败的 promise 去落定，结果依然是关闭。
 */
export function settleApiGate(initPromise?: Promise<unknown>): void {
  currentInitPromise = initPromise
  rearmApiGate()
}

/**
 * 重新装填播放门禁并挂到最新的初始化 promise 上。
 *
 * ## 为什么必须能重复调用
 *
 * 曾经只在启动时落定一次：如果启动时**没配置服务器**（例如用户清空了数据），
 * 门禁被置为 `false`；之后用户填好服务器并重连成功，门禁却**再也不会变回 true**，
 * 于是每首歌都报 `source init failed`，而连接明明是好的。
 *
 * 所以重连成功后必须调用本函数重新落定一次。
 */
export function rearmApiGate(): void {
  // 只有当门禁已经不处于「等待落定」时才需要重建
  if (global.lx.apiInitPromise[1]) {
    global.lx.apiInitPromise[0] = new Promise(resolve => {
      global.lx.apiInitPromise[1] = false
      global.lx.apiInitPromise[2] = (result: boolean) => {
        global.lx.apiInitPromise[1] = true
        resolve(result)
      }
    })
  }

  /**
   * 等音源就绪后再放行播放。
   *
   * ⚠️ 这里**不能**用 `apiInitPromise[1]` 做守卫：它正是上面刚置为 `false`
   * 的标志，用它判断会直接返回、门禁永远不落定（播放会一直卡在
   * 「等 apiInitPromise」上）。`[2]` 是在 Promise 构造器里**同步**赋值的，
   * 走到这里一定已是真正的 resolve 函数。
   */
  const settle = () => {
    if (!currentInitPromise) {
      global.lx.apiInitPromise[2](true)
      return
    }
    void currentInitPromise
      .then(() => { global.lx.apiInitPromise[2](true) })
      .catch((err: unknown) => {
        console.log('音源初始化失败:', err)
        global.lx.apiInitPromise[2](false)
      })
  }

  settle()
}

/**
 * 切换音源。
 *
 * ## 与上游的差别：`initPromise`
 *
 * 上游这里只发布 `qualityList`，音源的初始化交给别处。但本 fork 里
 * `musicSdk.init()` **不会被任何地方调用**，于是
 * `global.lx.apiInitPromise[0]` 会一直保持 `config/globalData.ts` 里的初值
 * `Promise.resolve(false)` —— 而 `handleGetOnlineMusicUrl` 等方法开头就是
 * `if (!await global.lx.apiInitPromise[0]) throw new Error('source init failed')`，
 * 结果是**每一首歌都播放失败**，且提示与真实原因（未配置 / 连不上服务器）无关。
 *
 * 因此这里把门禁接到**真实的初始化 promise** 上：
 * - 已配置服务器 → 等 `initPromise` 落定，成功才置为可用；
 * - 未配置服务器 → 立即置为不可用，播放时报错，用户去设置页填地址。
 *
 * `initPromise` 由 `core/init` 传入（那里调用 `initAnyListen()` 得到），
 * 这样本文件不必知道音源的具体实现。
 */
export const setApiSource = (apiId: string, initPromise?: Promise<unknown>) => {
  currentInitPromise = initPromise

  if (/^user_api/.test(apiId)) {
    setUserApi(apiId).catch(err => {
      console.log(err)
      // 上游会在这里回退到 apiSourceInfo 里的第一个内置源；本 fork 只有
      // anylisten 一个源，所以直接回退到它（已删除的 api-source-info 不再需要）。
      if (settingState.setting['common.apiSource'] != 'anylisten') setApiSource('anylisten', initPromise)
      else global.lx.apiInitPromise[2]?.(false)
    })
  } else {
    // @ts-expect-error 索引签名在 globalData 的类型里是宽松的
    global.lx.qualityList = musicSdk.supportQuality[apiId] ?? {}
    destroyUserApi()
    rearmApiGate()
  }

  if (apiId != settingState.setting['common.apiSource']) {
    updateSetting({ 'common.apiSource': apiId })
    requestAnimationFrame(() => {
      global.state_event.apiSourceUpdated(apiId)
    })
  }
}
