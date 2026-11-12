/**
 * SDK 会话的 workflow_lite 工具挂载。
 *
 * 引擎的处理器（`createWorkflowLiteHandler`）是宿主无关的：给它一份 deps 和一个
 * 会话 id，它就能在 SDK 会话里驱动同一套工作流实例（`resume` / `state` / 画布通知
 * 全走 `sessionOf(exec)` 提取的 `exec.agent.session.header.id`）。这里把它包成
 * Claude Agent SDK 的进程内 MCP 工具（`createSdkMcpServer` + `tool`）：
 *
 * - 每个 run 一份闭包，`header.id` 注入绑定的会话 id（画布会话 id 或 run id）；
 * - zod raw shape 全量镜像 `WorkflowLiteArgs` 的字段（zod 默认剥离未声明字段，
 *   漏一个字段模型就传不进去）；
 * - 工具名沿用 `TOOL_NAME`（`workflow_lite`），完整名 `mcp__workflow-lite__workflow_lite`；
 *   权限门（runner 的 canUseTool）按这个前缀放行。
 */

import {
  createSdkMcpServer,
  tool,
  type AnyZodRawShape,
  type McpSdkServerConfigWithInstance,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import {
  createWorkflowLiteHandler,
  DESCRIPTION,
  type ToolDeps,
  type ToolExecView,
  type WorkflowLiteArgs,
} from '../host/tool/tool.ts'
import { TOOL_NAME } from '../shared/types.ts'

/** MCP 服务器名：决定工具的完整名前缀 `mcp__workflow-lite__…`。 */
const MCP_SERVER_NAME = 'workflow-lite'

/**
 * `WorkflowLiteArgs` 的 zod 镜像。结构化字段（nodes / answers / outputs）给出
 * 字段级 shape；嵌套对象（input / resource / memory 及 display）保持 `unknown`
 * 让引擎自己的校验回错——它的错误信息比 zod 的更贴近动作语义。
 */
const argsShape = {
  action: z.string(),
  workflow: z.string().optional(),
  node: z.string().optional(),
  content: z.string().optional(),
  label: z.string().optional(),
  output: z.string().optional(),
  outputs: z
    .array(
      z.object({
        path: z.string(),
        rule: z.string().optional(),
        display: z.unknown().optional(),
      }),
    )
    .optional(),
  description: z.string().optional(),
  no_output: z.boolean().optional(),
  from_template: z.string().optional(),
  to: z.string().optional(),
  source: z.string().optional(),
  target: z.string().optional(),
  when: z.string().optional(),
  goal: z.string().optional(),
  full: z.boolean().optional(),
  output_root: z.string().optional(),
  mode: z.string().optional(),
  reuse: z.string().optional(),
  set_goal: z.boolean().optional(),
  handoff: z.string().optional(),
  handoff_note: z.string().optional(),
  update: z.boolean().optional(),
  run_state: z.boolean().optional(),
  instance: z.string().optional(),
  all: z.boolean().optional(),
  status: z.string().optional(),
  note: z.string().optional(),
  nodes: z
    .array(
      z.object({
        id: z.string(),
        status: z.string().optional(),
        summary: z.string().optional(),
        outputs: z.array(z.string()).optional(),
        verdict: z.string().optional(),
        error: z.string().optional(),
        by: z.string().optional(),
      }),
    )
    .optional(),
  log: z.string().optional(),
  input: z.unknown().optional(),
  answers: z
    .array(
      z.object({
        id: z.string(),
        value: z.string().optional(),
        values: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  resource: z.unknown().optional(),
  memory: z.unknown().optional(),
} satisfies AnyZodRawShape

/** SDK 会话绑定的画布会话：`resume` / `state` / 通知都按这个 id 寻址。 */
export interface WorkflowLiteSession {
  id: string
  /** 执行者的工作区根（相对路径从这里解析；缺省 = flowd 进程 cwd）。 */
  cwd?: string
}

/**
 * 造一个绑定了会话 id 的 workflow_lite MCP 服务器。每个 run 一份（deps 里的
 * 活配置照传，闭包只在 `header.id` 上不同）。
 */
export function createWorkflowLiteMcpServer(
  deps: ToolDeps,
  session: WorkflowLiteSession,
): McpSdkServerConfigWithInstance {
  const handler = createWorkflowLiteHandler(deps)
  const exec: ToolExecView = {
    agent: {
      session: {
        header: {
          id: session.id,
          ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
        },
      },
    },
  }
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '0.1.0',
    tools: [
      tool(TOOL_NAME, DESCRIPTION, argsShape, async (rawArgs) => {
        const value = await handler(rawArgs as unknown as WorkflowLiteArgs, exec)
        return { content: [{ type: 'text', text: JSON.stringify(value) }] }
      }),
    ],
  })
}

/** 权限门放行的 MCP 工具前缀：workflow_lite 是 SDK 会话驱动工作流的唯一入口。 */
export const WORKFLOW_LITE_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`
