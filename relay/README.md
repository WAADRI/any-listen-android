# any-listen HTTP 中转（relay）

把 any-listen 的**常驻 WebSocket 留在服务器上**，手机只发无状态的 HTTP 请求。

```
手机 App ──HTTP POST /rpc──▶ relay（本进程） ──常驻 WS──▶ any-listen
          ◀── { ok, data } ──                ◀── RPC 响应 ──
```

## 为什么需要它

直连 any-listen 时，手机和服务器之间是一条**有状态**的 WS 会话：断线后要重新
握手 → 建 socket → 重发 `inited`。Android 在后台会冻结 JS 定时器（真机日志里
出现过断线后 4 分钟才重连，而退避上限只有 30s），于是「重连」这件事本身就卡住了，
表现就是「后台播放时 WS 时断时续，只有回到前台才恢复」。

中转把这条会话搬到了服务器上：

- relay 到 any-listen 走本机/内网，链路稳定，重连逻辑也跑在 Node 里，不受手机休眠影响；
- 手机每次只发一个 HTTP 请求，成功与否只影响这一次调用；切换 Wi-Fi/蜂窝、
  NAT 超时都不会让一个需要重新握手的会话进入坏状态；
- 后端临时断开时，relay 会让请求**排队等重连**（默认最多 10 秒），连上后自动补发。

这不是「改成轮询」：没有后台定时请求，仍然只在 App 真正要数据时发 HTTP。

## 它解决 / 不解决什么

**解决**

- 后台播放时 WS 掉线导致的「连接未就绪」、切歌取址失败；
- 回前台才能重连（重连不再需要 App 的 JS 定时器）；
- 服务端 45s 空闲检测（relay 常驻，且会处理协议级 ping/pong）。

**不解决**

- Android 把整个 JS 线程完全冻结时，App 在冻结期间不会发出任何 HTTP 请求。
  中转不会唤醒 App；它保证的是「下一次请求不需要先恢复一条长连接」。
- 音频/封面仍然直接走 any-listen 的 HTTP 地址，不经过 relay。
- 服务端 → 客户端的广播（`listAction` 等）不会转发。当前 App 只做请求/响应，
  没有注册任何入站处理器；将来需要推送时可以在 relay 上加 SSE/长轮询。

## 环境要求

- **Node.js 22+**（使用内置的 `fetch` 与 `WebSocket`，零 npm 依赖）；
- 能访问 any-listen 的 HTTP 与 WebSocket。与 any-listen 同机时建议直接用
  `http://127.0.0.1:端口`，避免经过反向代理和公网。

## 快速开始

```bash
cd relay

ANYLISTEN_URL=http://127.0.0.1:8080 \
ANYLISTEN_PASSWORD='你的 any-listen 密码' \
RELAY_TOKEN='一串足够长的随机值' \
HOST=0.0.0.0 \
PORT=8099 \
node relay.mjs
```

生成令牌：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

启动后：

```
any-listen relay 1.0.0 已启动
  监听：http://本机所有地址:8099
  上游：http://127.0.0.1:8080
  令牌：已配置
```

自检：

```bash
curl -H 'Authorization: Bearer 你的令牌' http://127.0.0.1:8099/healthz
# {"ok":true,"connected":true,"state":"connected","serverId":"…","lastError":"","relayVersion":"1.0.0"}
```

### 在 App 里填写

设置 → 基础设置 → **any-listen 服务器**：

| 设置项 | 填什么 |
|---|---|
| 服务器地址 | any-listen 的地址（**不变**；封面/音频地址要用它解析） |
| 访问密码 | 保持原样即可；中转模式下 App 不再直接用它握手 |
| 中转地址 | 手机能访问到的 relay 地址，如 `http://192.168.1.2:8099` |
| 中转令牌 | relay 的 `RELAY_TOKEN`；relay 只监听本机且未设令牌时留空 |

保存后点「测试连接」，应当看到「HTTP 中转」与「中转会话」两步通过。
中转地址**留空**则继续直连 WebSocket，行为与旧版完全一致。

> 手机与 relay 不在同一局域网时，请用 HTTPS 暴露 relay（见下文），
> 否则令牌会以明文经过公网。

## 配置项

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `ANYLISTEN_URL` | 必填 | any-listen 地址，带 `http://` 或 `https://` |
| `ANYLISTEN_PASSWORD` | 必填 | any-listen 登录密码；只存在 relay 的内存/env 里 |
| `RELAY_TOKEN` | 空 | 手机访问 relay 的令牌；监听非回环地址时必填 |
| `HOST` | `127.0.0.1` | 监听地址；要让手机访问就设 `0.0.0.0` |
| `PORT` | `8099` | 监听端口 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` / `silent` |
| `RPC_TIMEOUT_MS` | `22000` | 单次上游 RPC 的总超时 |
| `WAIT_FOR_READY_MS` | `10000` | 后端断开时请求排队等重连的上限 |

也支持同名命令行参数：`--server=`、`--password=`、`--token=`、`--host=`、
`--port=`、`--log-level=`。命令行优先于环境变量。

## systemd

```ini
# /etc/systemd/system/any-listen-relay.service
[Unit]
Description=any-listen HTTP relay
After=network-online.target
Wants=network-online.target

[Service]
User=anylisten
EnvironmentFile=/etc/any-listen-relay.env
ExecStart=/usr/bin/node /opt/any-listen-relay/relay.mjs
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

```bash
# /etc/any-listen-relay.env  (chmod 600)
ANYLISTEN_URL=http://127.0.0.1:8080
ANYLISTEN_PASSWORD=...
RELAY_TOKEN=...
HOST=0.0.0.0
PORT=8099
```

## Docker

```bash
cd relay
docker build -t any-listen-relay .
docker run -d --name any-listen-relay --restart unless-stopped \
  -p 8099:8099 \
  -e ANYLISTEN_URL=http://host.docker.internal:8080 \
  -e ANYLISTEN_PASSWORD='...' \
  -e RELAY_TOKEN='...' \
  -e HOST=0.0.0.0 \
  any-listen-relay
```

Linux 上 `host.docker.internal` 需要 `--add-host=host.docker.internal:host-gateway`，
或者让容器直接使用宿主网络（`--network host`，此时 `ANYLISTEN_URL=http://127.0.0.1:8080`）。
也可以直接 `docker compose up -d` 使用同目录的 `docker-compose.yml`。

## 反向代理（TLS）

relay 只提供普通 HTTP 接口，**不涉及 WebSocket Upgrade**，反向代理配置很简单。
Caddy：

```
relay.example.com {
    reverse_proxy 127.0.0.1:8099
}
```

Nginx：

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;

    location / {
        proxy_pass http://127.0.0.1:8099;
        proxy_set_header Host $host;
    }
}
```

App 里的中转地址就填 `https://relay.example.com`。

## 安全

- 监听非回环地址时**必须**设置 `RELAY_TOKEN`；relay 会拒绝启动，避免把曲库裸奔在公网。
- 令牌用 `Authorization: Bearer` 传递；relay 用常量时间比较（先各自 sha256）。
- `ANYLISTEN_PASSWORD` 只用于 relay 向 any-listen 握手，不会下发给手机。
- 公网访问请务必套 TLS；relay 本身不带 TLS。
- 不要把 relay 端口暴露给不可信网络：拿到令牌就等于拿到你的 any-listen 读写权限。

## 接口

### `GET /healthz`

```json
{
  "ok": true,
  "relayVersion": "1.0.0",
  "state": "connected",
  "connected": true,
  "serverId": "…",
  "lastError": "",
  "reconnectAttempt": 0,
  "pending": 0,
  "queued": 0
}
```

`connected:false` 时 `lastError` / `state` 会说明原因（`connecting`、
`disconnected`、`auth-failed`）。

### `POST /rpc`

请求：

```json
{ "method": "getListMusics", "args": ["list-id"] }
```

响应：

```json
{ "ok": true, "data": [ ... ] }
```

业务错误（歌单不存在、服务端没装音源等）返回 HTTP 200：

```json
{ "ok": false, "error": { "code": "RPC_ERROR", "message": "没有这个歌单" } }
```

后端还没连上 / 调用超时返回可重试的 HTTP 状态：

| 状态 | code | 含义 |
|---|---|---|
| 503 | `BACKEND_UNAVAILABLE` | 后端未连接，重连后重试 |
| 504 | `RPC_TIMEOUT` | 已发出但上游没回 |
| 401 | `UNAUTHORIZED` | 中转令牌不对 |
| 400 | `BAD_REQUEST` | 请求体不合法 |
| 405 | `METHOD_NOT_ALLOWED` | 方法不对 |

`method` 必须是 any-listen 的**裸方法名**，不要带点号路径
（服务端是平铺工厂，写成 `list.getAllUserLists` 会报 `list is not defined`）。

## 实现要点

- 握手：`POST /api/ipc/ah`，头 `m = sha256hex(password + salt)`、`s = salt`，
  token 在响应头 `token` 里；随后连 `ws(s)://…/api/ipc/socket?m=<token>&t=main`。
- 每次连上都要重发 `inited`：服务端按 socket 记 `isInited`，重连后归零。
- 服务端每 30s 发一次文本 `ping`。**不要回 `pong`**：服务端会把任何非 JSON 文本
  当协议错误并 `close(4100)`；保活靠 WebSocket 协议级 ping/pong，由客户端实现自动应答。
- 超过 75s 没有任何入站帧 → 判定连接已死，主动重连。
- token 无过期时间；连续 3 次建连失败才会重新握手（服务端换了 tokenSecret 时自愈）。
- 401（密码错）不自动重试，避免把服务端的「10 次失败封 IP」打满；403 每 5 分钟重试。
- 单次 RPC 超时、未连接排队、重连退避（0.5s 起，上限 30s）。

## 故障排查

| 现象 | 处理 |
|---|---|
| App 测试连接报「中转令牌无效」 | App 的「中转令牌」与 `RELAY_TOKEN` 不一致 |
| `/healthz` 里 `state=auth-failed` | `ANYLISTEN_PASSWORD` 错；改正后**重启 relay**（401 不自动重试） |
| `/healthz` 里 `lastError` 是 `IP 已被 any-listen 封禁` | 连续密码错误导致 IP 被封；重启 any-listen 或等待 |
| `connected:false`、`lastError` 是 `握手请求失败` | relay 到 `ANYLISTEN_URL` 不通；先在 relay 机器上 `curl` 它 |
| 能读歌单但音频一直缓冲 | 音频不走 relay；检查手机能否访问 App 里配置的「服务器地址」 |
| 后台切换网络后第一次取址慢一两秒 | relay 在后端重连，HTTP 请求会排队；属于预期 |

日志默认在 stdout/stderr，`LOG_LEVEL=debug` 可以看到连接状态、
每次 RPC 的耗时（不会打印密码/token/请求体）。

## 测试

```bash
# relay 的协议、重连、HTTP 接口（零依赖）
node --test "relay/test/*.test.mjs"

# App 侧 HTTP 传输与会话选择
node --import ./tools/tsResolver.mjs --test "src/**/*.test.ts"
```

也可以从仓库根目录运行 `npm run test:relay`。
