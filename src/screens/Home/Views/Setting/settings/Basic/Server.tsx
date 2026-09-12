/**
 * any-listen 服务器配置。
 *
 * 这是本 fork 与上游最大的界面差异：上游的音源是内置的、无需配置，
 * 而这里必须让用户填自己的服务器地址与密码。
 *
 * ## 输入框为什么这样写
 *
 * 一开始照搬了「同步」页的 `settings/components/InputItem`（settings/Sync/IsEnable.tsx），
 * 那是本仓库唯一经过验证的服务器地址输入。但它**只在自己失焦时**才回调，
 * 而设置页的列表用了 `keyboardShouldPersistTaps="always"`，点按钮时输入框
 * 不会失焦 —— 于是回调从未触发，点「测试连接」时读到的是**空密码**。
 * 日志里留下了铁证：「密码诊断：长度=0」（空串的 sha256 是 `e3b0c442`）。
 *
 * 所以现在两个输入框各自 `memo` 成独立组件，内部自管 state 并**逐键**回调：
 *
 * - 最新值随时可用（`urlRef` / `passwordRef`），不依赖失焦这类交互时序；
 * - 逐键只更新各自的局部 state，不写全局设置，因此不会像早先那样
 *   每敲一个字就重渲染整页（实测出现过 `Skipped 80 frames!` 与
 *   `Davey! duration=1865ms`）。
 *
 * 键盘类型仍沿用「同步」页的做法：用 `inputMode="url"`，
 * 而不是 `keyboardType="url"`。
 *
 * ## 为什么「测试连接」要一路测到真实数据
 *
 * 配置错误的表现全部是**静默**的：地址写错、密码写错、反向代理没转发
 * WebSocket、服务器挂掉，在界面上都只是「没有歌」，报错也都是
 * 「source init failed」这类与真实原因无关的文本。
 *
 * 尤其不能只测握手：HTTP 的 `/api/ipc/ah` 在只配了普通反代的服务器上
 * 会成功，而真正取歌用的 `wss://…/api/ipc/socket` 被拒 —— 于是「测试连接」
 * 显示成功，用户却一首歌都放不出来。所以这里分四步，每步都给出结论：
 *
 *   1. 握手（HTTP）        —— 地址与密码是否正确
 *   2. WebSocket 连接      —— 反向代理是否正确转发了 Upgrade
 *   3. 取歌单列表          —— 会话与 inited 是否真的可用
 *   4. 取第一个歌单的歌曲  —— 完整的「服务端 → 曲库」链路
 *
 * 另外 401 与 403 必须区分：连续密码错误会被服务端拉黑 IP，
 * 这是用户必须立刻知道的信息，否则他会反复重试、把封禁时间拖长。
 */
import { memo, useCallback, useRef, useState } from 'react'
import { View } from 'react-native'

import Input from '@/components/common/Input'
import Text from '@/components/common/Text'
// 用设置页自己的 Button（`Setting/components/Button`），而不是通用的
// `@/components/common/Button`：前者自带 `c-button-background` 底色与内边距，
// 设置页里「导入导出」「清理缓存」等按钮用的都是它。之前这里用了通用 Button，
// 于是「测试连接 / 保存」是没有底色的裸文字，夹在其它按钮中间显得格格不入。
// 注意它**自己会把 children 包进 Text**，所以文案直接传字符串即可。
import Button from '../../components/Button'
import { createStyle, toast } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { updateSetting } from '@/core/common'
import { useSettingValue } from '@/store/setting/hook'
import { handshake, normalizeServerUrl } from '@/utils/anylisten/client'
import { restartAnyListen } from '@/core/init/anylisten'
import {
  getAllUserLists,
  getListMusics,
  resetSession,
  setupAnyListen,
  waitForConnected,
  type AnyListenMyAllList,
} from '@/utils/anylisten/api'

/** 每一步单独记录，便于失败时一眼看出走到了哪一步。 */
interface TestStep {
  label: string
  ok: boolean
  detail: string
}

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'done', steps: TestStep[] }

/** 整个测试的总超时：握手之外还有连接与两次 RPC，给足重试余地。 */
const TEST_TIMEOUT_MS = 30_000

/** 把可能很长的错误压成一行，避免撑破界面。 */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 160)

/** 统计服务端返回的歌单，顺带给出「有没有内容」的直观判断。 */
function summarizeLists(all: AnyListenMyAllList | undefined): { lists: number, tracks: number } {
  if (!all) return { lists: 0, tracks: 0 }
  const groups = [all.defaultList, all.loveList, all.lastPlayList, all.userList]
  let lists = 0
  let tracks = 0
  for (const group of groups) {
    if (!Array.isArray(group)) continue
    for (const item of group) {
      lists++
      tracks += item?.meta?.songCount ?? 0
    }
  }
  return { lists, tracks }
}

/**
 * 服务器地址输入框。
 *
 * ## 为什么不用 `InputItem`
 *
 * 上游设置页的文本输入走 `settings/components/InputItem`，它把内容放在
 * **自己的局部 state** 里，只在 `onBlur` / 键盘收起时才回调 —— 这样打字
 * 期间完全不惊动外层。对普通设置项这是对的。
 *
 * 但这里不行，实测踩到了：设置页的列表用了
 * `keyboardShouldPersistTaps="always"`，点按钮时输入框**不会失焦**，
 * 于是 `onChanged` 从未触发，回调拿到的始终是初始的空值。日志里表现为
 * 「密码诊断：长度=0」（空串的 sha256 是 e3b0c442），密码框明明有内容却
 * 校验失败。
 *
 * 所以这里自己维护局部 state + `onChangeText`：**每次按键都记下最新值**，
 * 但只改本组件自己的 state，不写全局设置、也不触发设置页重渲染，
 * 因此既没有 blur 依赖，也不会重现「打字卡死」。
 */
const UrlInput = memo(({ initialValue, onChange }: { initialValue: string, onChange: (value: string) => void }) => {
  const theme = useTheme()
  const [text, setText] = useState(initialValue)
  return (
    <View style={styles.field}>
      <Text size={13} style={styles.label}>服务器地址</Text>
      <Input
        value={text}
        placeholder="https://music.example.com"
        autoCorrect={false}
        // 与「同步」页一致：用 inputMode 而不是 keyboardType="url"
        inputMode="url"
        onChangeText={(next) => {
          setText(next)
          onChange(next)
        }}
        style={{ ...styles.input, backgroundColor: theme['c-primary-input-background'] }}
      />
    </View>
  )
})

/** 访问密码输入框。同样自己维护最新值，不依赖失焦。 */
const PasswordInput = memo(({ initialValue, onChange }: { initialValue: string, onChange: (value: string) => void }) => {
  const theme = useTheme()
  const [text, setText] = useState(initialValue)
  return (
    <View style={styles.field}>
      <Text size={13} style={styles.label}>访问密码</Text>
      <Input
        value={text}
        placeholder="与网页端登录使用同一个密码"
        autoCorrect={false}
        secureTextEntry
        inputMode="text"
        onChangeText={(next) => {
          setText(next)
          onChange(next)
        }}
        style={{ ...styles.input, backgroundColor: theme['c-primary-input-background'] }}
      />
    </View>
  )
})

const ServerSetting = memo(() => {
  const theme = useTheme()
  const savedUrl = useSettingValue('anylisten.serverUrl')
  const savedPassword = useSettingValue('anylisten.password')

  const [url, setUrl] = useState(savedUrl ?? '')
  const [password, setPassword] = useState(savedPassword ?? '')
  const [test, setTest] = useState<TestState>({ kind: 'idle' })

  // 界面上「最新的值」。两个输入框各自维护局部 state 并**逐键**回调，
  // 所以 ref 始终最新；用 ref 是为了让 test / save 直接读，不依赖 state 更新时机。
  const urlRef = useRef(url)
  const passwordRef = useRef(password)

  const handleUrlChange = useCallback((next: string) => {
    urlRef.current = next
  }, [])
  const handlePasswordChange = useCallback((next: string) => {
    passwordRef.current = next
  }, [])

  // 测试与保存都用 ref 里的最新值
  const current = useCallback(() => ({
    url: urlRef.current,
    password: passwordRef.current,
  }), [])

  const testSeq = useRef(0)

  const handleTest = useCallback(() => {
    const { url: rawUrl, password: pwd } = current()
    const seq = ++testSeq.current
    const normalized = normalizeServerUrl(rawUrl)
    if (!normalized) {
      setTest({ kind: 'done', steps: [{ label: '服务器地址', ok: false, detail: '请先填写服务器地址' }] })
      return
    }
    setTest({ kind: 'testing' })

    const steps: TestStep[] = []
    /** 记录一步。只在全部结束时落定 state，避免一次测试触发多次渲染。 */
    const push = (label: string, ok: boolean, detail: string) => {
      steps.push({ label, ok, detail })
    }

    const run = async() => {
      // 用输入框里的值，而不是已保存的值：用户正在测试尚未保存的配置。
      // setupAnyListen 是幂等的注入口，这里覆盖成当前输入即可。
      setupAnyListen({
        getCredentials: () => ({ serverUrl: normalized, password: pwd }),
      })
      resetSession()

      // 1. 握手 —— 验证地址与密码
      const hs = await handshake({
        serverUrl: normalized,
        password: pwd,
        fetchImpl: global.fetch as unknown as typeof fetch,
      })
      if (!hs.ok) {
        push('握手（地址与密码）', false, oneLine(hs.message))
        return
      }
      push('握手（地址与密码）', true, `服务器 ${hs.serverId ? hs.serverId.slice(0, 8) : '已确认'}`)

      // 2. 连接 WebSocket —— 反向代理最容易漏掉的一环。
      // 用 waitForConnected 而不是 connect()：后者在 socket open 之前就返回，
      // 会把「连不上」误报成成功，而那正是这个按钮要发现的问题。
      try {
        await waitForConnected(15_000)
      } catch (err: unknown) {
        push('WebSocket 连接', false,
          `${oneLine(err instanceof Error ? err.message : String(err))}。`
          + '请确认反向代理转发了 WebSocket Upgrade 请求（Nginx 需要 proxy_set_header Upgrade/Connection）。')
        return
      }
      push('WebSocket 连接', true, '已连接')

      // 3. 取歌单列表 —— 证明 inited 之后 RPC 真的可用
      const all = await getAllUserLists()
      const { lists, tracks } = summarizeLists(all)
      if (lists === 0) {
        push('读取歌单', false, '连接正常，但服务端没有返回任何歌单。请确认服务器上已有曲库。')
        return
      }
      push('读取歌单', true, `共 ${lists} 个歌单，${tracks} 首歌曲`)

      // 4. 取第一个歌单的歌曲 —— 走完「服务端 → 曲库」的完整链路
      const first = all.userList?.[0] ?? all.defaultList?.[0] ?? all.lastPlayList?.[0]
      if (!first?.id) {
        push('读取歌曲', true, '跳过（歌单数量不足以抽样）')
        return
      }
      const listTracks = await getListMusics(first.id)
      const count = Array.isArray(listTracks) ? listTracks.length : 0
      push('读取歌曲', true, `「${first.name ?? first.id}」返回 ${count} 首`)
    }

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => { reject(new Error(`测试超时（超过 ${TEST_TIMEOUT_MS / 1000} 秒无响应）`)) }, TEST_TIMEOUT_MS)
    })

    void Promise.race([run(), timeout]).then(() => {
      if (seq !== testSeq.current) return
      setTest({ kind: 'done', steps })
    }).catch((err: unknown) => {
      if (seq !== testSeq.current) return
      push('未预期的错误', false, oneLine(err instanceof Error ? err.message : String(err)))
      setTest({ kind: 'done', steps })
    })
  }, [current])

  const handleSave = useCallback(() => {
    const { url: rawUrl, password: pwd } = current()
    const normalized = normalizeServerUrl(rawUrl)
    updateSetting({
      'anylisten.serverUrl': normalized,
      'anylisten.password': pwd,
    })
    urlRef.current = normalized
    setUrl(normalized)

    // 只 resetSession() 是不够的：它只关掉旧 socket，**没有东西会重建连接**，
    // 而播放门禁仍是上个会话的 true。表现就是保存后进歌单页是空的，
    // 手动点一下排序才显示。所以这里必须真的重连。
    void restartAnyListen().then(() => {
      toast('已保存并重新连接')
    }).catch((err: unknown) => {
      // 重连失败要让用户看见，而不是留着「看起来已保存但什么都没有」的状态
      toast(`已保存，但连接失败：${err instanceof Error ? err.message : String(err)}`, 'long')
    })
  }, [current])

  // 主题里没有 `c-error` 这个键（只有 buildActiveThemeColors 列出的那些），
  // 取不到会得到 undefined，颜色静默失效。失败态统一用主色以保持可见。
  const failColor = theme['c-primary-font']

  const steps = test.kind === 'done' ? test.steps : []
  const allOk = test.kind === 'done' && steps.length > 0 && steps.every(s => s.ok)

  return (
    <View style={styles.container}>
      <Text style={styles.title} size={16}>any-listen 服务器</Text>
      <Text style={styles.desc} size={12}>
        本应用的歌曲、歌单、封面与歌词全部来自你自己部署的 any-listen 服务器。
      </Text>

      {/* 只在挂载时用已保存的值做初值：之后输入框自管内容，
          避免受控回写把用户正在输入的内容覆盖掉。 */}
      <UrlInput initialValue={url} onChange={handleUrlChange} />

      <Text size={11} style={styles.hint}>
        需带 http:// 或 https://。挂在反向代理子路径下时写完整路径（例如 https://example.com/music）。
      </Text>

      <PasswordInput initialValue={password} onChange={handlePasswordChange} />

      <Text size={11} style={styles.hint}>
        密码连续输错会被服务端拉黑 IP，请先用「测试连接」确认。
      </Text>

      <View style={styles.actions}>
        {/* 文案直接传字符串：设置页的 Button 自己会包一层 Text
            （裸字符串交给通用 Button 会抛
            "Text strings must be rendered within a <Text> component"）。 */}
        <Button onPress={handleTest} disabled={test.kind === 'testing'}>
          {test.kind === 'testing' ? '测试中…' : '测试连接'}
        </Button>
        <Button onPress={handleSave}>保存</Button>
      </View>

      {steps.length > 0 ? (
        <View style={styles.result}>
          {steps.map((step, index) => (
            <View key={`${index}-${step.label}`} style={styles.stepRow}>
              <Text size={13} color={step.ok ? theme['c-primary-font-active'] : failColor}>
                {step.ok ? '✓' : '✗'}
              </Text>
              <Text size={12} style={styles.stepLabel}>{step.label}</Text>
              <Text size={12} style={[styles.stepDetail, { color: step.ok ? theme['c-font-label'] : failColor }]}>
                {step.detail}
              </Text>
            </View>
          ))}
          {test.kind === 'done' ? (
            <Text size={12} style={styles.verdict} color={allOk ? theme['c-primary-font-active'] : failColor}>
              {allOk ? '全部通过，可以正常使用了' : '存在失败项，请按上面的提示处理'}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={styles.note}>
        <Text size={11} color={theme['c-font-label']}>
          修改地址或密码后请点「保存」，应用会重新建立连接。
        </Text>
      </View>
    </View>
  )
})

export default ServerSetting

const styles = createStyle({
  container: {
    paddingLeft: 25,
    paddingRight: 25,
    marginBottom: 18,
  },
  title: {
    marginLeft: -10,
    marginBottom: 6,
  },
  desc: {
    marginBottom: 16,
    lineHeight: 18,
  },
  field: {
    marginBottom: 4,
  },
  label: {
    marginBottom: 6,
  },
  input: {
    borderRadius: 4,
    paddingLeft: 8,
    paddingRight: 8,
  },
  hint: {
    marginTop: 6,
    marginBottom: 12,
    lineHeight: 16,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 12,
  },
  result: {
    marginBottom: 12,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 4,
  },
  stepLabel: {
    marginLeft: 6,
    marginRight: 6,
  },
  stepDetail: {
    flex: 1,
    lineHeight: 17,
  },
  verdict: {
    marginTop: 4,
  },
  note: {
    marginBottom: 4,
  },
})
