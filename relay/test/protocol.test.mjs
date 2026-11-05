import assert from 'node:assert/strict'
import test from 'node:test'

import {
  API_PREFIX,
  SOCKET_PATH,
  buildSocketUrl,
  decodeFrame,
  encodeCallbackResponse,
  encodeRequest,
  encodeResponse,
  normalizeServerUrl,
  sha256Hex,
} from '../lib/protocol.mjs'

test('sha256Hex 与标准实现一致', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
})

test('地址规整与 WS 地址拼接', () => {
  assert.equal(normalizeServerUrl(' https://music.example.com/ '), 'https://music.example.com')
  assert.equal(normalizeServerUrl('http://127.0.0.1:8080///'), 'http://127.0.0.1:8080')
  assert.equal(
    buildSocketUrl('https://music.example.com/music/', 'a b&c'),
    `wss://music.example.com/music${API_PREFIX}${SOCKET_PATH}?m=a%20b%26c&t=main`,
  )
  assert.equal(
    buildSocketUrl('http://127.0.0.1:8080', 'tok'),
    `ws://127.0.0.1:8080${API_PREFIX}${SOCKET_PATH}?m=tok&t=main`,
  )
})

test('请求帧与 App 侧 wire.ts 的形状一致', () => {
  assert.equal(
    encodeRequest('1', 'getListMusics', ['list-1']),
    '[0,"1",["getListMusics"],["list-1"],[]]',
  )
  assert.equal(encodeCallbackResponse('9', null), '[3,"9",null]')
})

test('响应帧解析：成功 / 错误 / 非 JSON / 回调', () => {
  assert.deepEqual(decodeFrame('[1,"7",null,{"a":1}]'), {
    kind: 'response',
    callId: '7',
    ok: true,
    data: { a: 1 },
  })
  assert.deepEqual(decodeFrame('[1,"7",{"message":"boom"}]'), {
    kind: 'response',
    callId: '7',
    ok: false,
    error: { message: 'boom' },
  })
  assert.equal(decodeFrame('ping').kind, 'unknown')
  assert.equal(decodeFrame('not json').kind, 'unknown')
  assert.equal(decodeFrame('[2,"3",{"x":1}]').kind, 'callback-request')
  assert.equal(decodeFrame('[0,"4",["listAction"],[{}],[]]').kind, 'request')
})

test('服务端广播请求用 op 1 应答，而不是 op 3', () => {
  const frame = decodeFrame('[0,"abc",["listAction"],[{"action":"add"}],[]]')
  assert.equal(frame.kind, 'request')
  // [1, id, null, null] 才是「对入站请求的响应」；
  // [3, ...] 是回调响应，原请求会在对端一直挂着。
  assert.equal(encodeResponse(frame.callId, null, null), '[1,"abc",null,null]')
  assert.equal(encodeCallbackResponse(frame.callId, null), '[3,"abc",null]')
})
