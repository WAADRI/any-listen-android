/**
 * HTTP 传输的接线检查。
 *
 * 中转模式最容易出现的不是协议错误，而是「配置加了但根本没人读」：
 * 设置项、默认值、类型、api 选择分支、设置页测试流程，任何一处漏掉，
 * 表现都只是「配了中转却仍在直连，后台照样掉线」。
 * 这里把这些接点逐个钉住。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { getSession, resetSession, setupAnyListen } from './api.ts'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8').replace(/\r\n/g, '\n')

test('api.ts 在配置了中转地址时创建 HTTP 会话', () => {
  const code = read('utils/anylisten/api.ts')
  assert.match(code, /AnyListenHttpSession/)
  assert.match(code, /normalizedRelayUrl/)
  assert.match(code, /relayToken/)
  assert.match(code, /session = normalizedRelayUrl\s*\n?\s*\?/)
})

test('HTTP 会话实现统一接口，并访问 /healthz 与 /rpc', () => {
  const code = read('utils/anylisten/http.ts')
  assert.match(code, /class AnyListenHttpSession implements AnyListenClient/)
  assert.match(code, /\/healthz/)
  assert.match(code, /\/rpc/)
  assert.match(code, /Authorization/)
})

test('设置项在默认值与类型里都登记了', () => {
  const defaults = read('config/defaultSetting.ts')
  assert.match(defaults, /'anylisten\.relayUrl': ''/)
  assert.match(defaults, /'anylisten\.relayToken': ''/)

  const types = read('types/app_setting.d.ts')
  assert.match(types, /'anylisten\.relayUrl': string/)
  assert.match(types, /'anylisten\.relayToken': string/)
})

test('设置页包含中转配置与探测流程', () => {
  const ui = read('screens/Home/Views/Setting/settings/Basic/Server.tsx')
  assert.match(ui, /probeRelay/)
  assert.match(ui, /'anylisten\.relayUrl'/)
  assert.match(ui, /'anylisten\.relayToken'/)
  assert.match(ui, /RelayUrlInput/)
  assert.match(ui, /RelayTokenInput/)
})

test('getSession() 按配置选择 HTTP 传输', async(t) => {
  const previousFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async(url: string) => {
    calls.push(String(url))
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async() => JSON.stringify({ ok: true, connected: true, serverId: 'sid' }),
    } as unknown as Response
  }) as typeof fetch

  t.after(() => {
    resetSession()
    globalThis.fetch = previousFetch
  })

  setupAnyListen({
    getCredentials: () => ({
      serverUrl: 'http://music.local',
      password: '',
      relayUrl: 'http://relay.local/',
      relayToken: 'secret',
    }),
  })

  const session = getSession()
  assert.equal(session.constructor.name, 'AnyListenHttpSession')
  await session.connect()
  assert.equal(session.getState(), 'connected')
  assert.ok(calls.includes('http://relay.local/healthz'))
})
