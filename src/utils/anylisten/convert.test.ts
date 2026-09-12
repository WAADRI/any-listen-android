/**
 * 适配层转换的回归测试。
 *
 * 这里覆盖的都是**不报错就会静默出错**的地方 —— 类型检查、lint、打包
 * 都不会发现它们，只有在真机上表现为「没声音 / 没封面 / 歌词空白」。
 * 因此这些断言不是形式，是这个 fork 里最容易再次被改坏的部分。
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  serverMusicInfoOf,
  MissingServerMusicInfoError,
  toLxMusicInfo,
  convertToSearchItem,
  setupConvert,
} from './convert.ts'
import type { AnyListenMusicInfo } from './types.ts'

const SERVER_URL = 'https://music.example.com'

/** 一份贴近实测的服务端曲目（字段名以真实返回为准）。 */
function serverTrack(): AnyListenMusicInfo {
  return {
    id: 'track-1',
    name: '从前',
    singer: '王俊凯',
    interval: '04:32',
    isLocal: true,
    meta: {
      musicId: 'track-1',
      albumName: '示例专辑',
      picUrl: './api/p_static/55edc556.jpeg',
      sizeStr: '4.2MB',
    },
  }
}

beforeEach(() => {
  setupConvert({ getServerUrl: () => SERVER_URL })
})

describe('serverMusicInfoOf', () => {
  test('从扁平对象（适配器真实入参）取出服务端原对象', () => {
    // core/music/utils.ts 传给适配器的是 toOldMusicInfo() 的结果，
    // 服务端原对象挂在顶层 anylisten 上。
    const raw = serverTrack()
    const flat = { id: 'anylisten_track-1', source: 'anylisten', anylisten: raw }

    assert.equal(serverMusicInfoOf(flat), raw)
  })

  test('从 lx 模型（meta.anylisten）取出服务端原对象', () => {
    const raw = serverTrack()
    const lxModel = { id: 'anylisten_track-1', meta: { anylisten: raw } }

    assert.equal(serverMusicInfoOf(lxModel), raw)
  })

  test('取不到原对象时抛专用错误，而不是静默重建', () => {
    // 这是最关键的一条：若这里退化成「用 lx 字段拼一个对象」，
    // 服务端会返回 HTTP 200 但给出占位地址 / 别人的封面 / 暂无歌词，
    // 全程没有任何报错。必须硬失败。
    assert.throws(
      () => serverMusicInfoOf({ id: 'anylisten_x', source: 'anylisten' }),
      MissingServerMusicInfoError,
    )
    assert.throws(() => serverMusicInfoOf(undefined), MissingServerMusicInfoError)
    assert.throws(() => serverMusicInfoOf({ anylisten: {} }), MissingServerMusicInfoError)
  })
})

describe('toLxMusicInfo', () => {
  test('封面在转换时就解析成绝对地址', () => {
    // lx 的 handleGetOnlinePicUrl 在 meta.picUrl 有值时**直接返回、不调 getPic**。
    // 若这里保留服务端原始的 './api/p_static/...'，封面会以同源相对路径
    // 交给图片层，结果是 FileNotFoundException（历史上坏过三次）。
    const info = toLxMusicInfo(serverTrack())

    assert.equal(info.meta.picUrl, `${SERVER_URL}/api/p_static/55edc556.jpeg`)
    assert.ok(!String(info.meta.picUrl).startsWith('./'), '不得残留同源相对路径')
  })

  test('原样保留服务端对象，供后续取址使用', () => {
    const raw = serverTrack()
    const info = toLxMusicInfo(raw)

    assert.equal(info.meta.anylisten, raw)
    assert.equal(info.meta.source, 'anylisten')
    // isLocal 必须传下去：服务端 findMusic 用它选择取址分支
    assert.equal(info.meta.anylistenIsLocal, true)
  })

  test('音质只声明服务端真正提供的 128k', () => {
    // assertApiSupport 依赖 qualityList；声明不存在的档位会让 UI 显示
    // 一个选了就播放失败的选项。
    const info = toLxMusicInfo(serverTrack())

    assert.deepEqual(info.meta.qualitys?.map(q => q.type), ['128k'])
  })

  test('缺 interval 时为 null 而不是空字符串', () => {
    const track = { ...serverTrack(), interval: null }
    assert.equal(toLxMusicInfo(track).interval, null)
  })

  test('服务端虚拟地址（al-ps-host:）被替换成真实地址', () => {
    const raw = serverTrack()
    raw.meta.picUrl = 'al-ps-host:/public/medias/abc.jpeg'

    // 注意是**替换**标记而不是拼接，服务端 buildRealPublicPath 就是这么做的
    assert.equal(toLxMusicInfo(raw).meta.picUrl, `${SERVER_URL}/public/medias/abc.jpeg`)
  })
})

describe('convertToSearchItem', () => {
  test('产出的形状满足 toNewMusicInfo 的读取要求', () => {
    // core/songlist.ts:111 与搜索链路都会把这项交给 toNewMusicInfo，
    // 而那个函数读取 songmid / img / types / _types，
    // 并无条件访问 meta._qualitys.flac32bit。
    const item = convertToSearchItem(serverTrack())

    assert.equal(typeof item.songmid, 'string')
    assert.equal(item.source, 'anylisten')
    assert.ok(Array.isArray(item.types), 'types 必须是数组')
    assert.ok(item._types && typeof item._types === 'object', '_types 必须是对象')
    // toNewMusicInfo 会读 meta._qualitys.flac32bit，所以 _types 不能是 null
    assert.ok('128k' in (item._types as Record<string, unknown>))
  })

  test('img 已解析成绝对地址', () => {
    // 这个值会被 toNewMusicInfo 写进 meta.picUrl，
    // 而 meta.picUrl 有值时封面会走不再解析的短路分支。
    const item = convertToSearchItem(serverTrack())

    assert.equal(item.img, `${SERVER_URL}/api/p_static/55edc556.jpeg`)
  })

  test('带上服务端原对象，供 toNewMusicInfo 的 anylisten 分支保留', () => {
    const raw = serverTrack()
    assert.equal(convertToSearchItem(raw).anylisten, raw)
  })

  test('没有封面时 img 为空字符串而不是 undefined', () => {
    // '' 与 undefined 在 toNewMusicInfo 那里都会写进 meta.picUrl，
    // 但空字符串会被后续的 falsy 判断正确处理，undefined 则可能漏进
    // Image 组件。统一成 ''。
    const raw = serverTrack()
    delete raw.meta.picUrl

    assert.equal(convertToSearchItem(raw).img, '')
  })
})
