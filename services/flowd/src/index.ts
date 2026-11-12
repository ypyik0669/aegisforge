/**
 * flowd 服务入口。
 *
 * 启动 Fastify 服务；环境变量：
 * - `AF_PORT`（默认 8899）、`AF_HOST`（默认 127.0.0.1）
 * - `AF_DATA_DIR`（默认 `<cwd>/data`）
 * - `AF_ANTHROPIC_API_KEY` / `AF_MODEL` / `AF_PERMISSION_MODE`（runner）
 *
 * 用法：`node lib/index.mjs [--help]`
 */

import { startServer } from './adapters/server.ts'

const USAGE = `aegisforge flowd — 安全工作流守护进程

用法:
  node lib/index.mjs              启动服务
  node lib/index.mjs --help       显示帮助

环境变量:
  AF_PORT                     监听端口（默认 8899）
  AF_HOST                     监听地址（默认 127.0.0.1）
  AF_DATA_DIR                 数据根目录（默认 <cwd>/data）
  AF_ANTHROPIC_API_KEY        Claude Agent SDK 凭据
  AF_MODEL                    模型（默认 claude-sonnet-4-6）
  AF_PERMISSION_MODE          default|acceptEdits|bypassPermissions|plan|delegate|dontAsk
  AF_LOG_LEVEL                Fastify 日志级别（如 info）

HTTP:
  GET  /api/health
  GET  /api/runs              列出本进程内的运行
  POST /api/runs              { prompt, workflowId?, model?, allowedTools? }
  GET  /api/runs/:id
  POST /api/runs/:id/steer    { text } 把一句话追加进运行
  POST /api/workflow-lite/*   画布 RPC（与上游端点清单一致）
`

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(USAGE)
  process.exit(0)
}

startServer()
  .then((server) => {
    const address = server.app.server.address()
    const where =
      typeof address === 'object' && address !== null
        ? `${address.address}:${address.port}`
        : String(address)
    process.stdout.write(`[flowd] 已启动 http://${where}\n`)
    const shutdown = (): void => {
      void server.app.close().finally(() => process.exit(0))
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    process.stderr.write(`[flowd] 启动失败：${message}\n`)
    process.exit(1)
  })
