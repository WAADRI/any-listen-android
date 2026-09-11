/**
 * any-listen 服务器配置。
 *
 * 这是本 fork 与上游最大的界面差异：上游的音源是内置的、无需配置，
 * 而这里必须让用户填自己的服务器地址与密码。
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
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { View } from 'react-native'

import Input from '@/components/common/Input'
import Text from '@/components/common/Text'
import Button from '@/components/common/Button'
import { createStyle, toast } from '@/utils/tools'
import { useTheme } from '@/store/theme/hook'
import { updateSetting } from '@/core/common'
import { useSettingValue } from '@/store/setting/hook'
import { handshake, normalizeServerUrl } from '@/utils/anylisten/client'
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

const ServerSetting = memo(() => {
  const theme = useTheme()
  const savedUrl = useSettingValue('anylisten.serverUrl')
  const savedPassword = useSettingValue('anylisten.password')

  const [url, setUrl] = useState(savedUrl ?? '')
  const [password, setPassword] = useState(savedPassword ?? '')
  const [test, setTest] = useState<TestState>({ kind: 'idle' })

  // 外部（例如导入配置）改了设置时同步回输入框
  useEffect(() => { setUrl(savedUrl ?? '') }, [savedUrl])
  useEffect(() => { setPassword(savedPassword ?? '') }, [savedPassword])

  const testSeq = useRef(0)

  const handleTest = useCallback(() => {
    const seq = ++testSeq.current
    const normalized = normalizeServerUrl(url)
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
        getCredentials: () => ({ serverUrl: normalized, password }),
      })
      resetSession()

      // 1. 握手 —— 验证地址与密码
      const hs = await handshake({
        serverUrl: normalized,
        password,
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
  }, [url, password])

  const handleSave = useCallback(() => {
    const normalized = normalizeServerUrl(url)
    updateSetting({
      'anylisten.serverUrl': normalized,
      'anylisten.password': password,
    })
    // 配置变了就丢弃旧会话，否则会继续用旧地址（表现为「改了地址还在读旧服务器」）
    resetSession()
    setUrl(normalized)
    toast('已保存')
  }, [url, password])

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

      <View style={styles.field}>
        <Text size={13} style={styles.label}>服务器地址</Text>
        <Input
          value={url}
          onChangeText={setUrl}
          placeholder="https://music.example.com"
          autoCorrect={false}
          keyboardType="url"
          style={{ ...styles.input, backgroundColor: theme['c-primary-input-background'] }}
          onClearText={() => { setUrl('') }}
          clearBtn={!!url}
        />
        <Text size={11} style={styles.hint}>
          需带 http:// 或 https://。挂在反向代理子路径下时写完整路径（例如 https://example.com/music）。
        </Text>
      </View>

      <View style={styles.field}>
        <Text size={13} style={styles.label}>访问密码</Text>
        <Input
          value={password}
          onChangeText={setPassword}
          placeholder="与网页端登录使用同一个密码"
          autoCorrect={false}
          secureTextEntry
          onClearText={() => { setPassword('') }}
          clearBtn={!!password}
        />
        <Text size={11} style={styles.hint}>
          密码连续输错会被服务端拉黑 IP，请先用「测试连接」确认。
        </Text>
      </View>

      <View style={styles.actions}>
        <Button onPress={handleTest} disabled={test.kind === 'testing'}>
          {/* Button 把 children 直接渲染进 Pressable，裸字符串会抛
              "Text strings must be rendered within a <Text> component"，
              所以按钮文案必须自己包 Text（与仓库内其他调用点一致）。 */}
          <Text color={theme['c-button-font']}>
            {test.kind === 'testing' ? '测试中…' : '测试连接'}
          </Text>
        </Button>
        <View style={styles.gap} />
        <Button onPress={handleSave}>
          <Text color={theme['c-button-font']}>保存</Text>
        </Button>
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
    // 与同一个 Section 下的其他项（SubTitle）保持一致的缩进
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
    marginBottom: 14,
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
    lineHeight: 16,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 12,
  },
  gap: {
    width: 12,
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
