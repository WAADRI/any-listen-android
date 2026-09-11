/**
 * sha256 纯实现的单测。
 *
 * 用**已知标准测试向量**而非「自己算一遍再对比自己」，后者等于没测。
 * 另外再与 Node 的 crypto 做随机交叉验证，覆盖多字节边界。
 *
 *   node --test "src/utils/anylisten/*.test.ts"
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

import { sha256Hex, bytesToHex, randomHex } from './sha256.ts'

const nodeSha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

test('标准测试向量：空串', () => {
  assert.equal(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )
})

test('标准测试向量：abc', () => {
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})

test('标准测试向量：448 位消息（跨填充边界）', () => {
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  )
})

test('标准测试向量：896 位消息（需要额外一个块）', () => {
  assert.equal(
    sha256Hex(
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmn' +
      'hijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    ),
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  )
})

test('100 万个 a（多块处理与长度累加）', () => {
  assert.equal(
    sha256Hex('a'.repeat(1_000_000)),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  )
})

test('与 Node crypto 交叉验证：覆盖所有填充边界长度', () => {
  // 55/56/57 与 63/64/65 是填充行为最容易写错的几个长度
  for (const len of [0, 1, 2, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
    const s = 'x'.repeat(len)
    assert.equal(sha256Hex(s), nodeSha256Hex(s), `长度 ${len} 不匹配`)
  }
})

test('与 Node crypto 交叉验证：随机内容', () => {
  for (let i = 0; i < 40; i++) {
    const s = randomBytes(1 + Math.floor(Math.random() * 300)).toString('base64')
    assert.equal(sha256Hex(s), nodeSha256Hex(s), `随机用例 ${i} 不匹配`)
  }
})

test('UTF-8 多字节字符按字节而非码元编码（密码含中文/emoji 时才会暴露）', () => {
  for (const s of ['密码', 'Test123.', '日本語テスト', 'café', 'a😀b', '中文mixed英文123']) {
    assert.equal(sha256Hex(s), nodeSha256Hex(s), `${s} 不匹配`)
  }
})

test('utf8 编码覆盖 1/2/3/4 字节边界', () => {
  // U+007F(1) U+0080(2) U+07FF(2) U+0800(3) U+FFFF(3) U+10000(4) U+10FFFF(4)
  const s = '\u007f\u0080\u07ff\u0800\uffff\u{10000}\u{10ffff}'
  assert.equal(sha256Hex(s), nodeSha256Hex(s))
})

test('服务端握手真实形状：sha256hex(password + salt)', () => {
  // 复现 tools/probe.mjs 里的算法，确认纯实现与探测脚本一致
  const password = 'Test123.'
  const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  assert.equal(sha256Hex(password + salt), nodeSha256Hex(password + salt))
})

test('输出恒为 64 位小写十六进制', () => {
  for (const s of ['', 'abc', '密码', 'a'.repeat(200)]) {
    const h = sha256Hex(s)
    assert.equal(h.length, 64)
    assert.match(h, /^[0-9a-f]{64}$/)
  }
})

test('bytesToHex 补零正确（高位为 0 的字节不能丢字符）', () => {
  assert.equal(bytesToHex(Uint8Array.from([0x00, 0x0f, 0x10, 0xff])), '000f10ff')
})

test('randomHex 产出正确长度且字符集合法', () => {
  const h = randomHex(16)
  assert.equal(h.length, 32)
  assert.match(h, /^[0-9a-f]{32}$/)
  // 不同调用应当给出不同盐（32 字节内碰撞概率可忽略）
  assert.notEqual(randomHex(32), randomHex(32))
})
