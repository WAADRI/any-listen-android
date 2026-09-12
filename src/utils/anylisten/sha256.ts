/**
 * SHA-256 的纯 JavaScript 实现。
 *
 * 为什么不用现成的：
 * - 项目自有的 `@/utils/nativeModules/crypto` **只有 SHA1**（`CryptoModule.sha1`），
 *   而 any-listen 的握手校验的是 `sha256hex(password + salt)`。
 * - 引入新的原生加密库要改 package.json 与 package-lock.json，而本项目此前正因为
 *   lockfile 里的 `git+ssh://` 依赖导致 CI 完全没有可用的 `npm ci`，
 *   不宜为单个哈希函数再动依赖树。
 *
 * 纯实现还有一个关键好处：它不依赖 React Native，因此可以被 `node --test`
 * 用**已知测试向量**直接验证（见 sha256.test.ts）。原生模块做不到这一点。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** 把任意字符串按 UTF-8 编成字节数组。 */
function utf8Bytes(input: string): Uint8Array {
  // 手写 UTF-8 编码，不依赖 TextEncoder：
  // 虽然 RN 0.73 与 Node 都提供 TextEncoder，但手写可以保证行为一致，
  // 也避免 polyfill 缺失时静默产错哈希（那会导致鉴权失败且极难排查）。
  const out: number[] = []
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i)

    // 处理代理对（emoji 等 BMP 外字符）
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000
        i++
      }
    }

    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return Uint8Array.from(out)
}

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/**
 * 计算字节数组的 SHA-256 摘要，返回 32 字节。
 */
export function sha256Bytes(message: Uint8Array): Uint8Array {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])

  // 填充：先写 0x80，再补 0 直到长度 ≡ 56 (mod 64)，最后 8 字节写比特长度（大端）。
  const msgLen = message.length
  //
  // 总长度必须是 msgLen + 1 + 8 向上取整到 64 的倍数。
  // 这里曾经写成 `(((msgLen + 9) >> 6) + 1) << 6`，它在 msgLen=55 时给出 128
  // 而正确答案是 64 —— 对短输入恰好正确、对 55 这类长度静默算错，
  // 是靠交叉验证测试才发现的。length 在 JS 里是 double，直接做浮点运算即可，
  // 不需要手写 32 位进位（msgLen 受数组长度限制，远小于 2^53）。
  const totalLen = Math.ceil((msgLen + 9) / 64) * 64
  const withPadding = new Uint8Array(totalLen)
  withPadding.set(message)
  withPadding[msgLen] = 0x80

  const bitLen = msgLen * 8
  const dv = new DataView(withPadding.buffer)
  // 高 32 位仅在消息超过 512MB 时非零，但写出来才是正确的 64 位大端
  dv.setUint32(totalLen - 8, Math.floor(bitLen / 0x100000000), false)
  dv.setUint32(totalLen - 4, bitLen >>> 0, false)

  const w = new Uint32Array(64)

  for (let offset = 0; offset < withPadding.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, h] = H

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    H[0] = (H[0] + a) >>> 0
    H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0
    H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0
    H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0
    H[7] = (H[7] + h) >>> 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, H[i], false)
  return out
}

const HEX = '0123456789abcdef'

/** 字节数组转小写十六进制。 */
export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[(bytes[i] >> 4) & 0xf] + HEX[bytes[i] & 0xf]
  }
  return out
}

/** 字符串的 sha256 小写十六进制摘要。 */
export function sha256Hex(input: string): string {
  return bytesToHex(sha256Bytes(utf8Bytes(input)))
}

/** 生成 n 字节的随机十六进制串，用作握手 salt。 */
export function randomHex(nBytes: number): string {
  const bytes = new Uint8Array(nBytes)
  for (let i = 0; i < nBytes; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytesToHex(bytes)
}
