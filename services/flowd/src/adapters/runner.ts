/**
 * flowd 的 Claude Agent SDK 会话注册表。
 *
 * 这里补上 DSH 宿主里由 `ctx.agents` 提供的东西：
 * - `spawnRun`：把一段提示词投进一个 SDK 会话（`query()`），返回 flowd 的会话 id 与句柄；
 * - `AgentHandle.steer`：上游 notice 用它把「用户改了运行状态」送进会话。
 *
 * SDK 的 `Query` 没有独立的 steer 方法；它支持**流式输入**——给 `query({ prompt })`
 * 传一个 `AsyncIterable<SDKUserMessage>` 就能在会话进行中继续投递用户消息。
 * 因此句柄内部维护一个消息队列：首轮 prompt 先入队，`steer` 再追加，SDK 会把它们
 * 当作后续轮次的用户输入（空闲时立刻开一轮，正在跑时在下一步接上）。
 *
 * 配置全部走环境变量：
 * - `AF_ANTHROPIC_API_KEY`：注入给 SDK 子进程的 `ANTHROPIC_API_KEY`；
 * - `AF_MODEL`：模型，默认 `claude-sonnet-4-6`；
 * - `AF_PERMISSION_MODE`：`default` / `acceptEdits` / `bypassPermissions` / `plan` /
 *   `delegate` / `dontAsk`，默认 `acceptEdits`；
 * - `AF_RUN_CWD`：会话工作目录，默认 `process.cwd()`；
 * - `AF_UNATTENDED_TOOLS`：`1` = 放行全部工具（默认只放只读工具，其余 deny）。
 *
 * TODO(flowd)：其它 provider（Bedrock / Vertex / 兼容网关）的凭据与 base URL 尚未接线，
 * 先由环境变量注入 `ANTHROPIC_*`。
 */

import { randomUUID } from 'node:crypto'
import {
  query,
  type Options,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AgentLike,
  AgentsRegistry,
  Context,
  Disposer,
  SessionId,
} from '../compat/cordis.ts'
import { userMessageText, type UserMessage } from '../compat/llm.ts'
import { TOOLBRIDGE_MCP_SERVER_NAME } from './toolbridgeMcp.ts'
import { WORKFLOW_LITE_TOOL_PREFIX } from './sdkTools.ts'

/**
 * 只读工具白名单：无论什么配置都放行——它们不产生副作用。
 * MCP 桥工具（workflow_lite / toolbridge）按前缀放行：前者是引擎自己的工具，
 * 后者的审批门在 Go guard（toolbridge 的设计点：双路径同一套审批/审计）。
 * 其余工具默认 **deny**（无人在场，'ask' 会挂死）；开发/受控环境用
 * `AF_UNATTENDED_TOOLS=1` 显式放行全部工具。`bypassPermissions` 模式下
 * SDK 根本不调 canUseTool，不经过这道门。
 */
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'TodoWrite',
  'TaskGet',
  'TaskList',
  'WebFetch',
  'WebSearch',
  'BashOutput',
  'KillShell',
])

const TOOLBRIDGE_TOOL_PREFIX = `mcp__${TOOLBRIDGE_MCP_SERVER_NAME}__`

/**
 * 审批门（统一审批中心的 SDK 侧入口）：deny-by-default 分支先问审批队列，
 * 有人在审批中心裁决则按裁决走，超时按拒绝。server.ts 在 AF_APPROVALS=1 时
 * 把 adapters/approvals.ts 的队列接进来；不接则维持原 deny 行为。
 */
export type ApprovalGate = (
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<
  { behavior: 'allow'; updatedInput: Record<string, unknown> } | { behavior: 'deny'; message: string }
>

function makePermissionGate(gate?: ApprovalGate): NonNullable<Options['canUseTool']> {
  const unattended = process.env.AF_UNATTENDED_TOOLS === '1'
  return async (toolName, toolInput) => {
    if (
      READ_ONLY_TOOLS.has(toolName) ||
      toolName.startsWith(WORKFLOW_LITE_TOOL_PREFIX) ||
      toolName.startsWith(TOOLBRIDGE_TOOL_PREFIX) ||
      unattended
    ) {
      return { behavior: 'allow', updatedInput: toolInput }
    }
    if (gate !== undefined) {
      return gate(toolName, toolInput)
    }
    return {
      behavior: 'deny',
      message:
        `工具 ${toolName} 需要副作用权限。flowd 默认只放行只读工具；` +
        `受控环境可设 AF_UNATTENDED_TOOLS=1 放行、AF_APPROVALS=1 走审批中心，` +
        `或把 permissionMode 配成 bypassPermissions（显式跳过全部权限）。`,
    }
  }
}

/** flowd 侧的一次运行状态。 */
export type RunStatus = 'starting' | 'running' | 'done' | 'failed' | 'stopped'

/** `GET /api/runs/:id` 看到的一条记录。 */
export interface RunInfo {
  id: string
  /** flowd 的会话 id（也是 `AgentHandle` 在注册表里的主键）。 */
  sessionId: string
  /** SDK init 消息里的真实会话 id（拿到之前为空）。 */
  sdkSessionId?: string
  status: RunStatus
  model: string
  prompt: string
  /** SDK 会话工作区（画布会话行用它当 session cwd）。 */
  cwd: string
  allowedTools: string[]
  startedAt: string
  updatedAt: string
  /** 助手消息计数（粗略轮次）。 */
  turns: number
  result?: string
  error?: string
}

/** `spawnRun` 的入参。 */
export interface SpawnRunInput {
  prompt: string
  /** 预分配的会话 id（如画布会话 id）；缺省 randomUUID。 */
  id?: string
  model?: string
  allowedTools?: string[]
  cwd?: string
  /** 逐 run 的凭据覆盖（llm_profiles resolve 的产物）；缺省用 RunnerConfig。 */
  apiKey?: string
  baseUrl?: string
  /** 进程内 MCP 服务器（如 workflow_lite）；键是 SDK 里的服务器名。 */
  mcpServers?: Options['mcpServers']
}

/** `spawnRun` 的返回值。 */
export interface SpawnedRun {
  sessionId: string
  handle: AgentHandle
}

/** 从环境变量读到的 runner 配置。 */
export interface RunnerConfig {
  model: string
  apiKey?: string
  permissionMode: PermissionMode
  cwd: string
  /** 其它 provider：llm_profiles resolve 后经 spawnRun 逐 run 覆盖。 */
  baseUrl?: string
  /** 统一审批中心（AF_APPROVALS=1 时由 server.ts 注入）。 */
  approvalGate?: ApprovalGate
  /** run 到终态（done/failed/stopped）时回调一次：通知渠道 / PG 镜像挂这里。 */
  onTerminal?: (info: RunInfo) => void
}

/** 读环境变量；所有默认值集中在这里。 */
export function readRunnerConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const apiKey =
    env.AF_ANTHROPIC_API_KEY !== undefined && env.AF_ANTHROPIC_API_KEY !== ''
      ? env.AF_ANTHROPIC_API_KEY
      : undefined
  const baseUrl =
    env.AF_ANTHROPIC_BASE_URL !== undefined && env.AF_ANTHROPIC_BASE_URL !== ''
      ? env.AF_ANTHROPIC_BASE_URL
      : undefined
  const model = env.AF_MODEL !== undefined && env.AF_MODEL !== '' ? env.AF_MODEL : 'claude-sonnet-4-6'
  return {
    model,
    ...(apiKey === undefined ? {} : { apiKey }),
    permissionMode: readPermissionMode(env.AF_PERMISSION_MODE),
    cwd:
      env.AF_RUN_CWD !== undefined && env.AF_RUN_CWD !== '' ? env.AF_RUN_CWD : process.cwd(),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  }
}

function readPermissionMode(value: string | undefined): PermissionMode {
  switch (value) {
    case 'default':
    case 'acceptEdits':
    case 'bypassPermissions':
    case 'plan':
    case 'delegate':
    case 'dontAsk':
      return value
    default:
      return 'acceptEdits'
  }
}

/** 流式输入队列：把多次 `push` 拼成一个 `AsyncIterable` 交给 SDK。 */
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffer: SDKUserMessage[] = []
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = []
  private closed = false

  push(message: SDKUserMessage): boolean {
    if (this.closed) return false
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter({ value: message, done: false })
    } else {
      this.buffer.push(message)
    }
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => this.next(),
    }
  }

  private next(): Promise<IteratorResult<SDKUserMessage>> {
    const queued = this.buffer.shift()
    if (queued !== undefined) return Promise.resolve({ value: queued, done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }
}

/** 包一条 SDK 用户消息（`session_id` 由 SDK 自己回填）。 */
function toSdkMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    session_id: '',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
  }
}

/** 一个 SDK 会话的 flowd 句柄：notice 经 `steer` 投递。 */
export class AgentHandle implements AgentLike {
  readonly ctx: Context
  readonly info: RunInfo

  private readonly queue = new MessageQueue()
  private readonly abortController = new AbortController()
  private readonly config: RunnerConfig
  private readonly mcpServers: Options['mcpServers']
  private readonly onSession: (sessionId: string) => void
  private query: Query | undefined
  private closed = false
  private terminalNotified = false

  constructor(input: {
    ctx: Context
    id: string
    prompt: string
    model: string
    allowedTools: string[]
    config: RunnerConfig
    mcpServers?: Options['mcpServers']
    onSession: (sessionId: string) => void
  }) {
    this.ctx = input.ctx
    this.config = input.config
    this.mcpServers = input.mcpServers
    this.onSession = input.onSession
    const now = new Date().toISOString()
    this.info = {
      id: input.id,
      sessionId: input.id,
      status: 'starting',
      model: input.model,
      prompt: input.prompt,
      cwd: input.config.cwd,
      allowedTools: input.allowedTools,
      startedAt: now,
      updatedAt: now,
      turns: 0,
    }
    this.queue.push(toSdkMessage(input.prompt))
    this.start(input)
  }

  /** 把一条用户消息送进会话；返回是否入队成功。 */
  steer(message: UserMessage): void {
    if (this.closed) return
    const text = userMessageText(message)
    if (text === '') return
    if (!this.queue.push(toSdkMessage(text))) return
    this.info.status = 'running'
    this.touch()
  }

  /** 关闭会话：结束输入流并中止 SDK 子进程。 */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.queue.close()
    this.abortController.abort()
    if (this.info.status === 'running' || this.info.status === 'starting') {
      this.info.status = 'stopped'
    }
    this.touch()
    this.notifyTerminal()
  }

  private start(input: {
    model: string
    allowedTools: string[]
    config: RunnerConfig
    mcpServers?: Options['mcpServers']
  }): void {
    const env: Record<string, string | undefined> = { ...process.env }
    if (input.config.apiKey !== undefined) env.ANTHROPIC_API_KEY = input.config.apiKey
    if (input.config.baseUrl !== undefined) env.ANTHROPIC_BASE_URL = input.config.baseUrl
    const options: Options = {
      model: input.model,
      cwd: this.config.cwd,
      env,
      allowedTools: input.allowedTools,
      ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
      permissionMode: this.config.permissionMode,
      ...(this.config.permissionMode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      abortController: this.abortController,
      canUseTool: makePermissionGate(this.config.approvalGate),
    }
    const session = query({ prompt: this.queue, options })
    this.query = session
    this.info.status = 'running'
    this.touch()
    void this.consume(session)
  }

  private async consume(session: Query): Promise<void> {
    try {
      for await (const message of session) {
        this.apply(message)
      }
      if (this.info.status === 'running' || this.info.status === 'starting') {
        this.info.status = 'stopped'
        this.touch()
        this.notifyTerminal()
      }
    } catch (error) {
      if (this.closed) return
      this.info.status = 'failed'
      this.info.error = error instanceof Error ? error.message : String(error)
      this.touch()
      this.notifyTerminal()
    }
  }

  /** 终态回调（通知/镜像），只发一次。 */
  private notifyTerminal(): void {
    if (this.terminalNotified) return
    if (this.info.status !== 'done' && this.info.status !== 'failed' && this.info.status !== 'stopped') {
      return
    }
    this.terminalNotified = true
    try {
      this.config.onTerminal?.(this.info)
    } catch {
      // 观察者不该影响运行主流程。
    }
  }

  private apply(message: SDKMessage): void {
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          this.info.sdkSessionId = message.session_id
          if (message.session_id !== this.info.id) this.onSession(message.session_id)
          if (this.info.status === 'starting') this.info.status = 'running'
        }
        break
      case 'assistant':
        this.info.turns += 1
        break
      case 'result':
        if (message.subtype === 'success' && !message.is_error) {
          this.info.status = 'done'
          this.info.result = message.result
        } else {
          this.info.status = 'failed'
          this.info.error =
            'errors' in message && Array.isArray(message.errors) && message.errors.length > 0
              ? message.errors.join('；')
              : message.subtype
        }
        this.notifyTerminal()
        break
      default:
        break
    }
    this.touch()
  }

  private touch(): void {
    this.info.updatedAt = new Date().toISOString()
  }
}

/** flowd 的 runner：保活会话表并把 flowd id 与 SDK id 都指向同一个句柄。 */
export class Runner {
  private readonly ctx: Context
  private readonly registry: AgentsRegistry
  private readonly config: RunnerConfig
  private readonly handles = new Map<SessionId, AgentHandle>()
  /** 被顶替的旧 run：从 handles 摘除但保留可见（列表不再丢失历史）。 */
  private readonly retired: AgentHandle[] = []

  constructor(options: { ctx: Context; registry: AgentsRegistry; config?: RunnerConfig }) {
    this.ctx = options.ctx
    this.registry = options.registry
    this.config = options.config ?? readRunnerConfig()
  }

  /** 起一个 SDK 会话并把 prompt 投进去。 */
  async spawnRun(input: SpawnRunInput): Promise<SpawnedRun> {
    const id = input.id ?? randomUUID()
    // 预分配 id（画布 sessionId）重发时旧 run 可能还活着：先关掉它，
    // 否则旧 SDK 子进程变孤儿。旧句柄退到 retired 列表，列表里仍可见。
    const superseded = this.handles.get(id)
    if (superseded !== undefined) {
      superseded.close()
      this.retired.push(superseded)
      if (this.retired.length > 50) this.retired.shift()
    }
    const handle = new AgentHandle({
      ctx: this.ctx,
      id,
      prompt: input.prompt,
      model: input.model ?? this.config.model,
      allowedTools: input.allowedTools ?? [],
      config: {
        ...this.config,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
      },
      ...(input.mcpServers === undefined ? {} : { mcpServers: input.mcpServers }),
      onSession: (sessionId) => {
        this.handles.set(sessionId, handle)
        this.registry.register(sessionId, handle)
      },
    })
    this.handles.set(id, handle)
    this.registry.register(id, handle)
    return { sessionId: id, handle }
  }

  get(id: string): AgentHandle | undefined {
    return this.handles.get(id)
  }

  list(): RunInfo[] {
    const unique = new Set<AgentHandle>([...this.handles.values(), ...this.retired])
    return [...unique].map((handle) => ({ ...handle.info }))
  }

  /** 关掉所有会话（服务退出时用）。 */
  closeAll(): void {
    for (const handle of new Set(this.handles.values())) handle.close()
    this.handles.clear()
  }
}

/** agent 注册表的最小实现。 */
export class AgentsRegistryImpl implements AgentsRegistry {
  private readonly agents = new Map<SessionId, AgentLike>()

  get(session: SessionId): AgentLike | undefined {
    return this.agents.get(session)
  }

  register(session: SessionId, agent: AgentLike): Disposer {
    this.agents.set(session, agent)
    return () => {
      if (this.agents.get(session) === agent) this.agents.delete(session)
    }
  }

  remove(session: SessionId): void {
    this.agents.delete(session)
  }
}

/** 造一个 agent 注册表。 */
export function createAgentsRegistry(): AgentsRegistryImpl {
  return new AgentsRegistryImpl()
}

/** 造一个 runner。 */
export function createRunner(options: {
  ctx: Context
  registry: AgentsRegistry
  config?: RunnerConfig
}): Runner {
  return new Runner(options)
}
