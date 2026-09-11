/**
 * serverUrl 解析器的单测。
 *
 * 用 Node 内置测试运行器直接跑真实模块（不是复制一份逻辑），
 * 因为本模块刻意不依赖 React Native：
 *
 *   node --test src/utils/anylisten/
 *
 * 这些断言里的期望值全部来自对真实服务器的实测，不是编造的：
 * 音频 `al-ps-host:/public/medias/<sha256>.mp3` 解析后 HEAD 返回
 * 200 / audio/mpeg；封面 `./api/p_static/<sha256>.jpeg` 是同源相对路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveServerUrl, isUsableArtworkUrl, VIRTUAL_PROTOCOL } from './serverUrl.ts'

const HOST = 'https://music.waadri.top'

test('虚拟标记被替换成 host，而不是拼在 host 后面', () => {
  const raw = 'al-ps-host:/public/medias/8b984867ff25.sqlite.mp3'
  assert.equal(resolveServerUrl(raw, HOST), `${HOST}/public/medias/8b984867ff25.sqlite.mp3`)
})

test('虚拟标记的替换不会留下标记本身', () => {
  const out = resolveServerUrl(`${VIRTUAL_PROTOCOL}/public/medias/x.mp3`, HOST)
  assert.ok(out !== null)
  assert.ok(!out.includes('al-ps-host'), `解析结果里仍有标记: ${out}`)
  assert.ok(!out.includes('//public'), `host 与路径之间被多插了一个斜杠: ${out}`)
})

test('同源相对封面路径 ./api/p_static/x.jpeg 要补全', () => {
  assert.equal(
    resolveServerUrl('./api/p_static/55edc556.jpeg', HOST),
    `${HOST}/api/p_static/55edc556.jpeg`,
  )
})

test('以 / 开头的路径补全 host（协议陷阱 5：代理返回的相对路径）', () => {
  assert.equal(resolveServerUrl('/public/medias/x.mp3', HOST), `${HOST}/public/medias/x.mp3`)
})

test('../ 形式的相对路径也要补全', () => {
  assert.equal(resolveServerUrl('../api/p_static/x.jpeg', HOST), `${HOST}/api/p_static/x.jpeg`)
})

test('已是绝对地址的原样返回', () => {
  assert.equal(
    resolveServerUrl('https://cdn.example.com/a.mp3', HOST),
    'https://cdn.example.com/a.mp3',
  )
})

test('serverUrl 带末尾斜杠不会产生双斜杠', () => {
  const out = resolveServerUrl('./api/p_static/x.jpeg', `https://h.example.com/`)
  assert.equal(out, 'https://h.example.com/api/p_static/x.jpeg')
})

test('serverUrl 带部署子路径时保留该子路径', () => {
  // 用户可能在反代下挂到 /music 之类的子路径上
  assert.equal(
    resolveServerUrl('al-ps-host:/public/medias/x.mp3', 'https://h.example.com/music'),
    'https://h.example.com/music/public/medias/x.mp3',
  )
})

test('空值与非字符串返回 null，而不是抛出或产出垃圾 URL', () => {
  for (const bad of [null, undefined, '', '   ', 0, {}, []]) {
    assert.equal(resolveServerUrl(bad, HOST), null, `输入 ${JSON.stringify(bad)} 应为 null`)
  }
})

test('null 输入在 serverUrl 缺失时也返回 null', () => {
  assert.equal(resolveServerUrl('/public/medias/x.mp3', ''), null)
  assert.equal(resolveServerUrl('al-ps-host:/public/x.mp3', ''), null)
})

test('无法识别的相对路径返回 null —— 宁可显示占位图，也不要交出解析不了的地址', () => {
  // 历史上封面坏掉的表现就是把这个字符串直接交给了图片层
  assert.equal(resolveServerUrl('not a url', HOST), null)
  assert.equal(resolveServerUrl('p_static/x.jpeg', HOST), null)
})

test('data: / file: 等由 RN 自行处理，原样放过', () => {
  assert.equal(resolveServerUrl('data:image/png;base64,AAA', HOST), 'data:image/png;base64,AAA')
  assert.equal(resolveServerUrl('file:///sdcard/a.jpg', HOST), 'file:///sdcard/a.jpg')
})

test('isUsableArtworkUrl 拒绝 null，接受非空字符串', () => {
  assert.equal(isUsableArtworkUrl(null), false)
  assert.equal(isUsableArtworkUrl(''), false)
  assert.equal(isUsableArtworkUrl(`${HOST}/api/p_static/x.jpeg`), true)
})

test('真实封面链路的端到端形状：解析后一定能通过 artwork 检查', () => {
  // 这是回归测试的核心：lx 原有的白名单正则会拒掉这两个真实值，
  // 导致通知栏封面静默消失。
  const legacyWhitelist = /^(https?:\/\/.+|\/.+)/

  const virtual = 'al-ps-host:/public/medias/x.jpg'
  const relative = './api/p_static/x.jpeg'

  // 先证明老逻辑确实会拒掉它们（否则这个回归测试就没有意义）
  assert.equal(legacyWhitelist.test(virtual), false)
  assert.equal(legacyWhitelist.test(relative), false)

  // 再过新逻辑：解析后可用
  assert.equal(isUsableArtworkUrl(resolveServerUrl(virtual, HOST)), true)
  assert.equal(isUsableArtworkUrl(resolveServerUrl(relative, HOST)), true)
})
