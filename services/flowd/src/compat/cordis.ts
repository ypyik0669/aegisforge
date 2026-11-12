/**
 * @deepseek-ai/cordis 的最小替代：flowd 的装配上下文。
 *
 * 只覆盖 vendored host 代码实际访问的成员：
 * - `Volatile<T>`：活配置引用（设置写入时就地更新）。
 * - `Context`：`get(name)`、`effect(dispose)` 与 `connection` / `tools` / `skills` /
 *   `agents` / `settings` 五个服务位。
 * - `FlowdConnection`：画布 RPC 的 Fetch 路由注册面。
 *
 * 上游用模块合并给 `ctx.get('agents')` 之类的调用补类型；这里直接在接口上做重载，
 * 避免引入 cordis 的服务容器。
 */

import type { ToolDefinition, ToolExecView } from './dshTools.ts'
import type { UserMessage } from './llm.ts'

/** dsh-session 里的会话 id：就是个字符串别名。 */
export type SessionId = string

/** 活配置引用（cordis 的 `Volatile`）。 */
export interface Volatile<T> {
  get(): T
}

/** 一个可变的活配置引用。 */
export interface MutableVolatile<T> extends Volatile<T> {
  set(value: T): void
}

/** 造一个活配置引用。 */
export function volatile<T>(initial: T): MutableVolatile<T> {
  let value = initial
  return {
    get: () => value,
    set: (next: T) => {
      value = next
    },
  }
}

/** 安装时登记的清理动作。 */
export type Disposer = () => void

/** 画布 RPC 的一条 Fetch 路由（`ctx.connection.fetch.register` 的入参）。 */
export interface FlowdFetchRoute {
  path: string
  methods: readonly string[]
  /** 上游要求缓冲请求体；flowd 侧由 Fastify 解析后重建成 Request。 */
  requestBody?: 'buffered'
  fetch: (request: Request) => Promise<Response>
}

/** 共享 Connection 的最小面。 */
export interface FlowdConnection {
  fetch: {
    register(route: FlowdFetchRoute): Disposer
  }
}

/**
 * RPC 信封里的结果形状（`dsh-client-connection` 的 `ConnectionRpcResult`）。
 * 失败时必须带 `details`，与上游 Wire 形状保持一致。
 */
export type ConnectionRpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** 工具注册表（`ctx.tools`）。 */
export interface ToolsService {
  register(spec: ToolDefinition<any, any>): Disposer
}

/** 一条内置 / 运行时 skill 的注册入参（`ctx.skills.register`）。 */
export interface SkillRegistration {
  name: string
  description: string
  whenToUse?: string
  source?: string
  content: string
}

/** skill 服务（`ctx.skills`）。 */
export interface SkillsService {
  register(spec: SkillRegistration): Disposer
}

/** 会话里的 agent：notice 经它把消息送进会话。 */
export interface AgentLike {
  readonly ctx: FlowdContext
  /** 空闲就开一轮，正在跑就排进下一步。 */
  steer(message: UserMessage): void
}

/** agent 注册表（`ctx.agents`）。 */
export interface AgentsRegistry {
  get(session: SessionId): AgentLike | undefined
  register(session: SessionId, agent: AgentLike): Disposer
  remove(session: SessionId): void
}

/** 宿主的设置服务（flowd 侧只用于「设置页」能力探测）。 */
export interface FlowdSettingsService {
  configure(options: { auto: boolean }, fiber?: unknown): unknown
}

/** 最小日志面。 */
export interface FlowdLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** flowd 的装配上下文：host 代码只认这一小截。 */
export interface FlowdContext {
  logger: FlowdLogger
  connection: FlowdConnection
  tools: ToolsService
  skills: SkillsService
  agents: AgentsRegistry
  settings?: FlowdSettingsService
  /** 取一个服务；已知服务名给具体类型。 */
  get(name: 'agents'): AgentsRegistry
  get(name: 'skills'): SkillsService
  get(name: 'connection'): FlowdConnection
  get(name: 'tools'): ToolsService
  get(name: 'settings'): FlowdSettingsService | undefined
  get(name: string): unknown
  /** 立即执行并记下清理动作（cordis 的 `effect`）。 */
  effect(fn: () => void | Disposer, label?: string): void
}

/** 上游 host 代码统一按 `Context` 引用这个接口。 */
export type Context = FlowdContext

/** `createFlowdContext` 需要的服务。 */
export interface FlowdContextParts {
  logger?: FlowdLogger
  connection: FlowdConnection
  tools: ToolsService
  skills: SkillsService
  agents: AgentsRegistry
  settings?: FlowdSettingsService
}

/** 一个极简的装配上下文：服务直接持有，effect 立即执行并收集清理动作。 */
export class FlowdContextImpl implements FlowdContext {
  readonly logger: FlowdLogger
  readonly connection: FlowdConnection
  readonly tools: ToolsService
  readonly skills: SkillsService
  readonly agents: AgentsRegistry
  readonly settings?: FlowdSettingsService
  private readonly disposers: Disposer[] = []

  constructor(parts: FlowdContextParts) {
    this.logger = parts.logger ?? {
      info: (message) => console.log(message),
      warn: (message) => console.warn(message),
      error: (message) => console.error(message),
    }
    this.connection = parts.connection
    this.tools = parts.tools
    this.skills = parts.skills
    this.agents = parts.agents
    this.settings = parts.settings
  }

  get(name: 'agents'): AgentsRegistry
  get(name: 'skills'): SkillsService
  get(name: 'connection'): FlowdConnection
  get(name: 'tools'): ToolsService
  get(name: 'settings'): FlowdSettingsService | undefined
  get(name: string): unknown
  get(name: string): unknown {
    switch (name) {
      case 'agents':
        return this.agents
      case 'skills':
        return this.skills
      case 'connection':
        return this.connection
      case 'tools':
        return this.tools
      case 'settings':
        return this.settings
      default:
        return undefined
    }
  }

  effect(fn: () => void | Disposer, label?: string): void {
    try {
      const dispose = fn()
      if (typeof dispose === 'function') this.disposers.push(dispose)
    } catch (error) {
      this.logger.warn(`[flowd] effect ${label ?? ''} 失败：${String(error)}`)
      throw error
    }
  }

  /** 按登记的逆序跑一遍清理动作（服务关闭时用）。 */
  disposeAll(): void {
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // 清理失败不阻断其它清理。
      }
    }
  }
}

/** 造一个装配上下文。 */
export function createFlowdContext(parts: FlowdContextParts): FlowdContextImpl {
  return new FlowdContextImpl(parts)
}

/** 工具的 `execute` 可用的执行上下文（转发类型，方便适配层引用）。 */
export type { ToolExecView }
