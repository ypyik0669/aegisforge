/**
 * SDK 会话的 toolbridge 工具挂载：把 Go 基座（ARTEX）的工具注册表镜像进
 * Claude Agent SDK 会话。
 *
 * Go 侧是工具 SSOT（pkg/toolbridge）：`GET /api/tools/registry` 出目录，
 * `POST /api/tools/invoke` 执行——每次调用都过同一条 guard 链（内置 deny 规则 /
 * 用户 intercept 规则 / target gate），与 Go agent 运行时共用审批与审计。
 * 这里不镜像每个工具的 zod shape（JSON Schema → zod 转换既脆又丢语义），而是
 * 暴露两个固定工具：
 *
 * - `go_tools_list`：注册表目录（工具 key + 描述 + 参数契约摘要），建会话时拉一次；
 * - `go_tool`：按 key + args 对象调用，回执原样透传 Go 的文本结果。
 *
 * 完整名 `mcp__toolbridge__go_tool`；权限门（runner 的 canUseTool）按
 * `mcp__toolbridge__` 前缀放行——真正的审批门在 Go guard，不在 flowd 的
 * deny-by-default（双路径同一套审批/审计正是 toolbridge 的设计目标）。
 *
 * 配置：`AF_TOOLS_BRIDGE_URL`（Go 网关或 standalone cmd/flowdbridge 的地址）、
 * 可选 `AF_TOOLS_BRIDGE_TOKEN`（Bearer）。未配置时不挂载。
 */

import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

/** MCP 服务器名：决定工具的完整名前缀 `mcp__toolbridge__…`。 */
export const TOOLBRIDGE_MCP_SERVER_NAME = 'toolbridge'

/** `GET /api/tools/registry` 里的一条。 */
interface RegistryEntry {
  key?: string
  description?: string
  enabled?: boolean
}

/** toolbridge 的连接配置。 */
export interface ToolBridgeOptions {
  /** Go 侧基址（如 http://127.0.0.1:8901）。 */
  baseUrl: string
  /** 可选 Bearer token（Go 网关的 JWT）。 */
  token?: string
}

function bridgeHeaders(opts: ToolBridgeOptions): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  }
  if (opts.token !== undefined && opts.token !== '') headers.authorization = `Bearer ${opts.token}`
  return headers
}

/** 拉注册表并排成模型可读的目录文本。 */
async function fetchListing(opts: ToolBridgeOptions): Promise<string> {
  let response: Response
  try {
    response = await fetch(`${opts.baseUrl}/api/tools/registry`, {
      headers: { ...bridgeHeaders(opts), accept: 'application/json' },
    })
  } catch (error) {
    return `toolbridge registry unreachable (${error instanceof Error ? error.message : String(error)})`
  }
  if (!response.ok) {
    return `toolbridge registry HTTP ${String(response.status)}`
  }
  try {
    const body = (await response.json()) as { tools?: RegistryEntry[] }
    const tools = Array.isArray(body.tools) ? body.tools : []
    if (tools.length === 0) return '(registry empty)'
    return tools
      .map((entry) => {
        const key = typeof entry.key === 'string' ? entry.key : '(unnamed)'
        const desc = typeof entry.description === 'string' ? entry.description : ''
        const off = entry.enabled === false ? ' [disabled]' : ''
        return `- ${key}${off}: ${desc}`
      })
      .join('\n')
  } catch {
    return 'toolbridge registry returned a malformed response'
  }
}

/**
 * 建 toolbridge MCP 服务器（每个 SDK 会话一份）。
 * 注册表在建会话时拉一次；调用失败在 `go_tool` 回执里如实呈现。
 */
export async function createToolBridgeMcpServer(
  opts: ToolBridgeOptions,
): Promise<McpSdkServerConfigWithInstance> {
  const listing = await fetchListing(opts)
  return createSdkMcpServer({
    name: TOOLBRIDGE_MCP_SERVER_NAME,
    version: '0.1.0',
    tools: [
      tool(
        'go_tools_list',
        'List the Go-side (ARTEX) tool registry: one line per tool with its key and contract. Call this first to discover which tools exist and what each expects.',
        {},
        async () => ({ content: [{ type: 'text', text: listing }] }),
      ),
      tool(
        'go_tool',
        'Invoke a Go-side ARTEX tool by key through the toolbridge. Every call passes the Go guard chain (built-in deny rules; user intercept rules and the target gate when the full server is wired). Discover tool keys with go_tools_list; pass arguments matching the tool schema.',
        {
          tool: z.string().describe('tool key from the registry (e.g. pj_case)'),
          args: z
            .record(z.string(), z.unknown())
            .optional()
            .describe('arguments object matching the tool schema'),
        },
        async (args) => {
          let response: Response
          try {
            response = await fetch(`${opts.baseUrl}/api/tools/invoke`, {
              method: 'POST',
              headers: bridgeHeaders(opts),
              body: JSON.stringify({ tool: args.tool, args: args.args ?? {} }),
            })
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text: `toolbridge unreachable (${error instanceof Error ? error.message : String(error)})`,
                },
              ],
            }
          }
          const body = await response.text()
          if (!response.ok) {
            return {
              content: [{ type: 'text', text: `toolbridge HTTP ${String(response.status)}: ${body.slice(0, 500)}` }],
            }
          }
          try {
            const parsed = JSON.parse(body) as { content?: unknown; is_error?: unknown }
            const text = typeof parsed.content === 'string' ? parsed.content : body
            return { content: [{ type: 'text', text }] }
          } catch {
            return { content: [{ type: 'text', text: body }] }
          }
        },
      ),
    ],
  })
}
