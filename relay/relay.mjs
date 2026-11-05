#!/usr/bin/env node
/**
 * any-listen HTTP 中转服务（零依赖，Node 22+）。
 *
 * 架构：
 *
 *   手机 App ──HTTP──▶ 本进程 ──常驻 WebSocket──▶ any-listen
 *
 * 为什么要放在 any-listen 同一台机器上：
 * 手机在后台会掉 WS（系统冻结 JS、切网、NAT 超时），而 WS 的重连逻辑
 * 需要定时器、握手、inited 状态。把 WS 留在服务器上，它到 any-listen
 * 走的是本机/内网稳定链路；手机每次只发一个无状态的 HTTP 请求，
 * 失败一次只影响那一次请求，不会让会话进入「必须回前台才能恢复」的状态。
 *
 * 用法：
 *   ANYLISTEN_URL=http://127.0.0.1:8080 \
 *   ANYLISTEN_PASSWORD=your-password \
 *   RELAY_TOKEN=long-random-token \
 *   node relay.mjs
 *
 * 更多说明见同目录 README.md。
 */
import { readFileSync } from 'node:fs'

import { AnyListenBackend } from './lib/backend.mjs'
import { createRelayServer } from './lib/http.mjs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

function createLogger(level) {
  const threshold = LEVELS[level] ?? LEVELS.info
  const write = (name, args) => {
    if (LEVELS[name] < threshold) return
    const line = `[${new Date().toISOString()}] ${name.toUpperCase()} ${args.map(String).join(' ')}`
    if (name === 'error' || name === 'warn') console.error(line)
    else console.log(line)
  }
  return {
    debug: (...args) => write('debug', args),
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
  }
}

function parseArgs(argv) {
  const out = {}
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      out.help = true
      continue
    }
    if (arg === '--version' || arg === '-v') {
      out.version = true
      continue
    }
    const match = /^--([a-zA-Z-]+)=(.*)$/.exec(arg)
    if (!match) throw new Error(`无法识别的参数：${arg}`)
    out[match[1]] = match[2]
  }
  return out
}

const USAGE = `any-listen relay ${pkg.version}

用法：
  ANYLISTEN_URL=http://127.0.0.1:8080 \\
  ANYLISTEN_PASSWORD=密码 \\
  RELAY_TOKEN=随机长令牌 \\
  node relay.mjs

环境变量：
  ANYLISTEN_URL        any-listen 地址。与中转同机时建议用 http://127.0.0.1:端口
  ANYLISTEN_PASSWORD   any-listen 的登录密码（中转用它维持 WS，不会下发到手机）
  RELAY_TOKEN          手机访问中转用的令牌；监听非回环地址时必填
  HOST                 监听地址，默认 127.0.0.1
  PORT                 监听端口，默认 8099
  LOG_LEVEL            debug | info | warn | error | silent，默认 info
  RPC_TIMEOUT_MS       单次上游调用的超时，默认 22000
  WAIT_FOR_READY_MS    后端断开时请求排队等重连的上限，默认 10000

命令行参数（覆盖环境变量）：
  --server=http://127.0.0.1:8080
  --password=...
  --token=...
  --host=127.0.0.1
  --port=8099
  --log-level=info
`

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(err.message)
    console.error(USAGE)
    process.exit(2)
  }

  if (args.help) {
    console.log(USAGE)
    return
  }
  if (args.version) {
    console.log(pkg.version)
    return
  }

  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor < 22) {
    console.error(`需要 Node.js 22 或更高版本（当前 ${process.versions.node}）：内置 WebSocket 从 Node 22 起可用。`)
    process.exit(1)
  }
  if (typeof globalThis.WebSocket !== 'function') {
    console.error('当前 Node 没有全局 WebSocket，请升级到 Node 22+。')
    process.exit(1)
  }

  const serverUrl = args.server ?? process.env.ANYLISTEN_URL ?? ''
  const password = args.password ?? process.env.ANYLISTEN_PASSWORD
  const token = args.token ?? process.env.RELAY_TOKEN ?? ''
  const host = args.host ?? process.env.HOST ?? '127.0.0.1'
  const port = Number(args.port ?? process.env.PORT ?? 8099)
  const logLevel = args['log-level'] ?? process.env.LOG_LEVEL ?? 'info'
  const rpcTimeoutMs = Number(process.env.RPC_TIMEOUT_MS ?? 22_000)
  const waitForReadyMs = Number(process.env.WAIT_FOR_READY_MS ?? 10_000)
  const log = createLogger(logLevel)

  if (!serverUrl) {
    console.error('缺少 ANYLISTEN_URL（例如 http://127.0.0.1:8080）。')
    process.exit(2)
  }
  if (!/^https?:\/\//i.test(serverUrl)) {
    console.error('ANYLISTEN_URL 必须以 http:// 或 https:// 开头。')
    process.exit(2)
  }
  if (password === undefined) {
    console.error('缺少 ANYLISTEN_PASSWORD。中转需要它来维持 WebSocket 连接。')
    process.exit(2)
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`PORT 不合法：${port}`)
    process.exit(2)
  }
  if (!isLoopbackHost(host) && !token) {
    console.error(
      '监听非回环地址时必须设置 RELAY_TOKEN。\n' +
      '否则任何能访问这个端口的人都能以你的身份读取曲库。\n' +
      '生成一个：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    )
    process.exit(2)
  }
  if (!token) {
    log.warn('未设置 RELAY_TOKEN：只监听本机，App 的令牌留空即可。')
  }

  const backend = new AnyListenBackend({
    serverUrl,
    password,
    logger: log,
    onStateChange: (state, detail) => {
      log.debug(`[state] ${state}${detail ? `：${detail}` : ''}`)
    },
  })

  const server = createRelayServer({
    backend,
    token,
    logger: log,
    version: pkg.version,
    rpcTimeoutMs,
    waitForReadyMs,
  })

  server.on('error', (err) => {
    log.error(`HTTP 服务出错：${err.message}`)
    process.exitCode = 1
  })

  backend.start()
  server.listen(port, host, () => {
    const displayHost = host === '0.0.0.0' || host === '::' ? '本机所有地址' : host
    log.info(`any-listen relay ${pkg.version} 已启动`)
    log.info(`  监听：http://${displayHost}:${port}`)
    log.info(`  上游：${serverUrl}`)
    log.info(`  令牌：${token ? '已配置' : '未配置（仅本机）'}`)
    log.info('按 Ctrl+C 退出。')
  })

  let shuttingDown = false
  const shutdown = (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info(`收到 ${signal}，正在退出…`)
    backend.stop()
    server.close(() => {
      process.exit(0)
    })
    setTimeout(() => process.exit(0), 3_000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main()
