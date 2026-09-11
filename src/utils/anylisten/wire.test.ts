/**
 * 帧编解码的单测。
 *
 * 断言的是**真实帧的字面形状**，不是「编码再解码等于自己」。
 * 期望值来自对线上部署 bundle 的阅读与对真实服务器的实测。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  OP,
  encodeRequest,
  encodeCallbackResponse,
  decodeFrame,
  isPing,
  PING_TEXT,
} from './wire.ts'

test('请求帧是数组，且顺序为 [op, callId, path, args, callbacks]', () => {
  const raw = encodeRequest('1', ['getAllUserLists'], [])
  // 直接断言字面结构，避免「自己编码自己解码」的循环论证
  assert.equal(raw, '[0,"1",["getAllUserLists"],[],[]]')
  assert.deepEqual(JSON.parse(raw), [0, '1', ['getAllUserLists'], [], []])
})

test('请求帧不是对象形状（npm message2call 0.1.3 的形状会被服务端拒绝）', () => {
  const parsed = JSON.parse(encodeRequest('1', ['inited'], []))
  assert.ok(Array.isArray(parsed), '帧必须是数组；对象帧会触发服务端 message is not array')
  assert.equal(typeof parsed, 'object')
  assert.equal(Array.isArray(parsed) && parsed.constructor === Array, true)
})

test('path 只有一段时应保持单段（写成两段会让服务端报 "list is not defined"）', () => {
  const frame = JSON.parse(encodeRequest('9', ['getListMusics'], ['du3jglgqkj8']))
  assert.deepEqual(frame[2], ['getListMusics'])
  assert.equal(frame[2].length, 1, 'path 必须只有一段')
  assert.deepEqual(frame[3], ['du3jglgqkj8'])
})

test('args 里放对象参数（getMusicUrl 需要整个 musicInfo）', () => {
  const musicInfo = { id: 'x', name: '从前', meta: { musicId: 'x' } }
  const frame = JSON.parse(encodeRequest('2', ['getMusicUrl'], [{ musicInfo }]))
  assert.deepEqual(frame[3], [{ musicInfo }])
})

test('成功响应 [1, id, null, data] 解码为 ok:true 并带出 data', () => {
  const d = decodeFrame(JSON.stringify([OP.RESPONSE, 'abc', null, { a: 1 }]))
  assert.equal(d.kind, 'response')
  assert.equal(d.ok, true)
  assert.deepEqual(d.data, { a: 1 })
})

test('成功响应的 data 为 null 时也判为成功（inited 就返回 null）', () => {
  const d = decodeFrame(JSON.stringify([OP.RESPONSE, 'abc', null, null]))
  assert.equal(d.kind, 'response')
  assert.equal(d.ok, true)
  assert.equal(d.data, null)
})

test('错误响应 [1, id, {message}] 解码为 ok:false', () => {
  const d = decodeFrame(
    JSON.stringify([OP.RESPONSE, 'abc', { message: "NOT NULL constraint failed: my_list.meta" }]),
  )
  assert.equal(d.kind, 'response')
  assert.equal(d.ok, false)
  assert.equal(d.error.message, 'NOT NULL constraint failed: my_list.meta')
})

test('错误槽是字符串而非对象时也要能读出 message', () => {
  const d = decodeFrame(JSON.stringify([OP.RESPONSE, 'abc', 'boom']))
  assert.equal(d.kind, 'response')
  assert.equal(d.ok, false)
  assert.equal(d.error.message, 'boom')
})

test('服务端真实的 "list is not defined" 错误能被读出', () => {
  // 这是嵌套路径写错时的真实报错，必须能被看见而不是被吞掉
  const d = decodeFrame(JSON.stringify([OP.RESPONSE, '1', { message: 'list is not defined' }]))
  assert.equal(d.ok, false)
  assert.equal(d.error.message, 'list is not defined')
})

test('入站请求帧（服务端推送 listAction）解码正确', () => {
  const payload = [{ action: 'list_create', data: { position: -1, listInfos: [] } }]
  const d = decodeFrame(JSON.stringify([OP.REQUEST, '77', ['listAction'], payload, []]))
  assert.equal(d.kind, 'request')
  assert.deepEqual(d.path, ['listAction'])
  assert.deepEqual(d.args, payload)
})

test('回调帧解码正确', () => {
  const req = decodeFrame(JSON.stringify([OP.CALLBACK_REQUEST, '5', { x: 1 }]))
  assert.equal(req.kind, 'callback-request')
  assert.deepEqual(req.content, { x: 1 })

  const res = decodeFrame(JSON.stringify([OP.CALLBACK_RESPONSE, '5', 42]))
  assert.equal(res.kind, 'callback-response')
  assert.equal(res.content, 42)
})

test('心跳：纯文本 ping 不是 JSON，必须被识别而不是当成解析失败', () => {
  assert.equal(isPing(PING_TEXT), true)
  const d = decodeFrame(PING_TEXT)
  // 帧解析层把它归为 unknown 是正确的 —— 心跳在更外层按字符串处理
  assert.equal(d.kind, 'unknown')
  assert.equal(isPing('pong'), false)
  assert.equal(isPing(undefined), false)
})

test('垃圾输入一律归为 unknown，绝不抛出', () => {
  for (const bad of [
    undefined, null, 0, '', '{', '[]', '[1]', '[9,1]', '{"name":"x"}',
    [{ op: 0 }], JSON.stringify({ op: 0 }),
  ]) {
    assert.doesNotThrow(() => decodeFrame(bad), `输入 ${JSON.stringify(bad)} 抛出了`)
    const d = decodeFrame(bad)
    assert.ok(d.kind === 'unknown' || d.kind === 'request', `输入 ${JSON.stringify(bad)} 解出了 ${d.kind}`)
  }
})

test('不认识的 opcode 归为 unknown 而不是被误当成响应', () => {
  assert.equal(decodeFrame(JSON.stringify([99, '1', null, 'x'])).kind, 'unknown')
})

test('callId 被统一成字符串（服务端可能回 number）', () => {
  const d = decodeFrame(JSON.stringify([OP.RESPONSE, 7, null, 'ok']))
  assert.equal(d.kind, 'response')
  assert.equal(d.callId, '7')
})

test('回调响应编码形状正确', () => {
  assert.equal(encodeCallbackResponse('3', { done: true }), '[3,"3",{"done":true}]')
})
