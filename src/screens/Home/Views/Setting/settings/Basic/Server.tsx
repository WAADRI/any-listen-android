/**
 * any-listen 服务器配置。
 *
 * 这是本 fork 与上游最大的界面差异：上游的音源是内置的、无需配置，
 * 而这里必须让用户填自己的服务器地址与密码。
 *
 * ## 为什么要一个「测试连接」按钮
 *
 * 配置错误的表现全部是**静默**的：地址写错、密码写错、服务器挂掉，
 * 在界面上都只是「没有歌」。而这些原因的处理方式完全不同
 * （地址要改 URL、密码错会累计失败次数导致**服务端封 IP**、
 * 服务器挂掉只能等），所以这里把具体原因直接显示出来。
 *
 * 特别注意 401 与 403 的区分：连续密码错误会被服务端拉黑 IP，
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
import { resetSession } from '@/utils/anylisten/api'

type TestState =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok', serverId: string }
  | { kind: 'fail', message: string }

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
      setTest({ kind: 'fail', message: '请先填写服务器地址' })
      return
    }
    setTest({ kind: 'testing' })
    void handshake({
      serverUrl: normalized,
      password,
      fetchImpl: global.fetch as unknown as typeof fetch,
    }).then((result) => {
      // 丢弃过期结果：用户可能在等待期间又点了一次
      if (seq !== testSeq.current) return
      if (result.ok) {
        setTest({ kind: 'ok', serverId: result.serverId })
      } else {
        setTest({ kind: 'fail', message: result.message })
      }
    }).catch((err: unknown) => {
      if (seq !== testSeq.current) return
      setTest({ kind: 'fail', message: err instanceof Error ? err.message : String(err) })
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

  const statusColor = test.kind === 'ok'
    ? theme['c-primary-font-active']
    : test.kind === 'fail' ? theme['c-error'] : theme['c-font-label']

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
          {test.kind === 'testing' ? '测试中…' : '测试连接'}
        </Button>
        <View style={styles.gap} />
        <Button onPress={handleSave}>保存</Button>
      </View>

      {test.kind !== 'idle' && test.kind !== 'testing' ? (
        <View style={styles.result}>
          <Text size={13} color={statusColor}>
            {test.kind === 'ok'
              ? `连接成功${test.serverId ? `（服务器 ${test.serverId.slice(0, 8)}）` : ''}`
              : `连接失败：${test.message}`}
          </Text>
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
  note: {
    marginBottom: 4,
  },
})
