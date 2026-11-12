/**
 * flowd 的 Fastify 装配入口。
 *
 * 把 vendored 的 workflow-lite host 半边接到 flowd 上：
 * - 文件仓储 + `RunService`（上游 `apply()` 的顺序与语义）；
 * - 模型工具 `workflow_lite`（compat 的工具注册表）；
 * - 三个内置 skill（workflow-authoring / workflow-run-state / workflow-board）；
 * - 画布 RPC：上游注册成 Connection Fetch 路由，这里落成 `POST <path>`；
 * - flowd 自己的 HTTP 面：健康检查与 SDK 运行（`/api/runs`）。
 *
 * 装配枢纽是 `compat/cordis.ts` 的 `FlowdContext`；服务对象都是真实实现：
 * 设置读 JSON、skill 扫目录、agent 是 Claude Agent SDK 会话。
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import {
  createFlowdContext,
  type Disposer,
  type FlowdConnection,
  type FlowdFetchRoute,
  type ToolsService,
} from '../compat/cordis.ts'
import { createUserMessage } from '../compat/llm.ts'
import { registerAuthoringSkill } from '../host/authoringSkill.ts'
import { registerBoardSkill } from '../host/boardSkill.ts'
import { registerWorkflowLiteRpc } from '../host/rpc.ts'
import { Config, type WorkflowLiteSettings } from '../host/config.ts'
import { pluginVersion } from '../host/version.ts'
import { createNotify } from '../host/runs/notice.ts'
import { RunService } from '../host/runs/service.ts'
import { registerRunStateSkill } from '../host/runs/skill.ts'
import { createSkillViewer } from '../host/skillView.ts'
import { memoryMetaFile } from '../host/store/paths.ts'
import {
  createRepository,
  reportProblems,
  type Repository,
} from '../host/store/repository.ts'
import { registerWorkflowLiteTool } from '../host/tool/tool.ts'
import type { SettingsPort } from '../host/pluginConfig.ts'
import { type PluginConfigValues, WORKFLOW_LITE_ENDPOINTS } from '../shared/wire.ts'
import { validateDocument } from '../shared/validate.ts'
import type { WorkflowDocument } from '../shared/types.ts'
import {
  createRunner,
  createAgentsRegistry,
  readRunnerConfig,
  type Runner,
} from './runner.ts'
import { createSettings, type SettingsAdapter } from './settings.ts'
import { createSkillsStore } from './skillsStore.ts'
import { createWorkflowLiteMcpServer } from './sdkTools.ts'
import { createToolBridgeMcpServer } from './toolbridgeMcp.ts'
import { createProfileStore, profilesFilePath, type ProfileStore } from './profiles.ts'
import { createApprovalQueue, type ApprovalQueue } from './approvals.ts'
import { readNotifyChannels, sendRunNotice } from './notify.ts'
import { createMirrorSender, type MirrorSender } from './mirror.ts'

/** `buildServer` 的可选项。 */
export interface ServerOptions {
  /** 监听端口；缺省读 `AF_PORT`，再缺省 8899。 */
  port?: number
  /** 监听地址；缺省读 `AF_HOST`，再缺省 127.0.0.1。 */
  host?: string
  /** 启动数据根；缺省读 `AF_DATA_DIR`，再缺省 `<cwd>/data`。 */
  dataDir?: string
  /** Fastify 日志开关（`AF_LOG_LEVEL` 也能打开）。 */
  logger?: boolean
}

/** 装配好的服务。 */
export interface FlowdServer {
  app: FastifyInstance
  ctx: ReturnType<typeof createFlowdContext>
  repository: Repository
  settings: SettingsAdapter
  runs: RunService
  runner: Runner
  dataDir: string
}

/** 装配，不监听。 */
export async function buildServer(options: ServerOptions = {}): Promise<FlowdServer> {
  const app = Fastify({
    // 画布 RPC 的 pack/upload 会把整包分块放进 JSON；给足上限。
    bodyLimit: 64 * 1024 * 1024,
    logger:
      options.logger === true || process.env.AF_LOG_LEVEL !== undefined
        ? { level: process.env.AF_LOG_LEVEL ?? 'info' }
        : false,
  })
  // 上游客户端按 JSON 发；兼容 text/plain 直发（curl 时方便）。
  app.addContentTypeParser(
    ['text/plain', 'application/octet-stream'],
    { parseAs: 'string' },
    (_request, body, done) => done(null, body),
  )

  // 画布从浏览器直连（NEXT_PUBLIC_FLOWD_BASE）时是跨源请求；AF_CORS=1 打开。
  // 走 Go 网关反代的生产部署保持同源，不开。
  if (process.env.AF_CORS === '1') {
    await app.register(cors, { origin: true })
  }

  // ── 设置 ───────────────────────────────────────────────────
  const settings = createSettings(options.dataDir ?? Config.dataDir)
  const live: WorkflowLiteSettings = settings.live
  // 数据根在装配时定住（与上游 apply() 一致）：改了设置要重启才换。
  const dataDir = live.dataDir.get()

  const validate = (document: WorkflowDocument, workflow: string) =>
    reportProblems(
      validateDocument(document, {
        workflowName: workflow,
        maxNodes: live.maxNodes.get(),
        hasMemory: (id) => existsSync(memoryMetaFile(dataDir, id)),
      }),
    )

  const repository = createRepository({ dataDir, validate })
  const layout = await repository.ensureLayout()

  // ── 服务实现 ────────────────────────────────────────────────
  const skills = createSkillsStore(dataDir)
  const registry = createAgentsRegistry()
  const context = createFlowdContext({
    connection: createConnection(app),
    tools: createToolsRegistry(),
    skills,
    agents: registry,
  })
  if (!layout.ok) {
    context.logger.warn(`[workflow-lite] 数据目录不可用：${layout.error.message}`)
  }

  const runnerConfig = readRunnerConfig()

  // llm_profiles：standalone 部署的文件态 provider 层（fs.watch 热加载）。
  const profiles = createProfileStore(profilesFilePath(dataDir), (line) => context.logger.info(line))

  // 统一审批中心（SDK 路径）：AF_APPROVALS=1 时非白名单副作用工具挂起等裁决。
  const approvalsEnabled = process.env.AF_APPROVALS === '1'
  const approvals: ApprovalQueue | undefined = approvalsEnabled
    ? createApprovalQueue({
        dataDir,
        timeoutMs:
          Number.isFinite(Number(process.env.AF_APPROVAL_TIMEOUT_MS)) &&
          Number(process.env.AF_APPROVAL_TIMEOUT_MS) > 0
            ? Number(process.env.AF_APPROVAL_TIMEOUT_MS)
            : undefined,
        log: (line) => context.logger.info(line),
      })
    : undefined

  // run 终态观察者：通知渠道 + PG 镜像（都按环境变量开关，缺省静默）。
  const notifyChannels = readNotifyChannels()
  const mirror: MirrorSender = createMirrorSender(
    process.env.AF_MIRROR_URL !== undefined && process.env.AF_MIRROR_URL !== ''
      ? process.env.AF_MIRROR_URL
      : undefined,
    fetch,
    (line) => context.logger.info(line),
  )
  // 工作流绑定：workflowId 路径 spawn 时记住 runId → 图（终态镜像要带 workflow
  // 上下文，PG workflow_runs 的 workflow_id/name 才不为空）。终态后即清。
  const workflowBindings = new Map<string, { id: string; name: string }>()
  runnerConfig.onTerminal = (info) => {
    if (Object.values(notifyChannels).some((value) => value !== undefined)) {
      void sendRunNotice(notifyChannels, info).then((results) => {
        const failed = results.filter((entry) => entry !== 'ok')
        if (failed.length > 0) context.logger.warn(`[flowd] notify failures: ${failed.join('; ')}`)
      })
    }
    const bound = workflowBindings.get(info.id)
    void mirror.send(info, bound)
    if (bound !== undefined) workflowBindings.delete(info.id)
  }

  const runner = createRunner({
    ctx: context,
    registry,
    config: { ...runnerConfig, ...(approvals === undefined ? {} : { approvalGate: async (toolName, toolInput) => approvals.request('', toolName, toolInput) }) },
  })
  const runs = new RunService({
    dataDir: () => dataDir,
    validate,
    notify: createNotify(context),
  })

  // 内置 skill：按上游 apply() 的顺序注册；`installSkill` 关掉就跳过。
  if (live.installSkill.get()) {
    context.effect(() => registerAuthoringSkill(context), 'flowd: workflow-authoring skill')
    context.effect(() => registerRunStateSkill(context), 'flowd: workflow-run-state skill')
    context.effect(() => registerBoardSkill(context), 'flowd: workflow-board skill')
  }

  // 唯一的模型可见工具。
  context.effect(
    () =>
      registerWorkflowLiteTool(context, {
        repository,
        dataDir: () => dataDir,
        maxResultBytes: () => live.maxResultBytes.get(),
        runs,
      }),
    'flowd: workflow_lite tool',
  )

  // 画布 RPC：与上游一样的端点清单与信封。
  context.effect(
    () =>
      registerWorkflowLiteRpc(context, {
        repository,
        dataDir: () => dataDir,
        limits: () => ({
          maxNodes: live.maxNodes.get(),
          saveDebounceMs: live.saveDebounceMs.get(),
        }),
        runs,
        skills: createSkillViewer(context, () => skills),
        config: {
          port: (): SettingsPort => settings,
          live: (): PluginConfigValues => settings.values(),
        },
        pack: {
          skillsRoot: join(homedir(), '.agents', 'skills'),
          plugin: packageVersion(),
          validate,
        },
      }),
    'flowd: canvas RPC',
  )

  // ── flowd 自己的 HTTP 面 ────────────────────────────────────
  app.get('/api/health', async () => ({
    ok: true,
    service: 'flowd',
    version: '0.1.0',
    dataDir,
    model: runnerConfig.model,
    /** SDK 凭据是否已由环境变量提供（不暴露值）。 */
    hasApiKey: runnerConfig.apiKey !== undefined,
  }))

  // 画布的会话列表：一次进程内全部 run（新在前由客户端排序）。
  app.get('/api/runs', async () => ({ runs: runner.list() }))

  app.post('/api/runs', async (request, reply) => {
    const body = asRecord(request.body)
    const prompt = typeof body.prompt === 'string' ? body.prompt : undefined
    const workflowId = typeof body.workflowId === 'string' ? body.workflowId : undefined
    if (prompt === undefined && workflowId === undefined) {
      return reply.code(400).send({ error: 'prompt or workflowId is required' })
    }
    // 会话绑定：画布带 sessionId 来 = SDK 会话直接用这个 id（画布 / RPC / 通知同址寻址）；
    // 没带 = 预分配一个 id 当会话 id。
    const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
    const bindId = sessionId ?? randomUUID()
    // 缺省工作区 = dataDir（flowd 的数据沙箱）：实例产出在 dataDir/runs/<id>/out，
    // SDK 的 acceptEdits 只自动批准 cwd 子树内的写入，落在别处会被权限门拦住。
    const cwd = typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : dataDir

    // workflowId 路径走 RunService.start：建实例、绑会话、出 startPrompt（模型据此
    // 用 workflow_lite resume 拿计划，实例归属就是 bindId）。
    let instanceId: string | undefined
    let planId: string | undefined
    let fullPrompt = prompt ?? ''
    if (workflowId !== undefined) {
      const load = await repository.load(workflowId)
      if (!load.exists) {
        return reply.code(404).send({ error: { code: 'not_found', message: `图 ${workflowId} 不存在` } })
      }
      if (!load.loadable || load.document === null) {
        return reply.code(409).send({
          error: { code: 'blocked', message: `图 ${workflowId} 有保存级问题，无法执行` },
          problems: load.problems,
        })
      }
      const started = await runs.start({
        workflow: workflowId,
        document: load.document,
        problems: load.problems,
        session: { id: bindId, ...(cwd === undefined ? {} : { cwd }) },
        ...(body.answers !== undefined && body.answers !== null ? { answers: body.answers } : {}),
      })
      if (!started.ok) {
        return reply.code(started.error.code === 'blocked' ? 409 : 400).send({
          error: started.error,
        })
      }
      instanceId = started.result.instance.id
      planId = started.result.instance.planId
      fullPrompt = prompt === undefined ? started.result.prompt : `${started.result.prompt}\n\n${prompt}`
      workflowBindings.set(bindId, { id: workflowId, name: load.name })
    }

    // 每个 SDK 会话挂一个绑定会话 id 的 workflow_lite MCP 工具。
    const mcpServers: Record<string, Awaited<ReturnType<typeof createWorkflowLiteMcpServer>>> = {
      'workflow-lite': createWorkflowLiteMcpServer(
        {
          repository,
          dataDir: () => dataDir,
          maxResultBytes: () => live.maxResultBytes.get(),
          runs,
        },
        { id: bindId, ...(cwd === undefined ? {} : { cwd }) },
      ),
    }
    // toolbridge：Go 基座工具注册表镜像（guard 审批在 Go 侧）；未配置不挂载。
    const bridgeUrl = process.env.AF_TOOLS_BRIDGE_URL
    if (bridgeUrl !== undefined && bridgeUrl !== '') {
      mcpServers['toolbridge'] = await createToolBridgeMcpServer({
        baseUrl: bridgeUrl,
        ...(process.env.AF_TOOLS_BRIDGE_TOKEN !== undefined && process.env.AF_TOOLS_BRIDGE_TOKEN !== ''
          ? { token: process.env.AF_TOOLS_BRIDGE_TOKEN }
          : {}),
      })
    }
    // 逐 run provider 覆盖：显式 body.profileId → llm_profiles 里那条；否则
    // 文件里唯一 isDefault 的条目。resolve 不到就回落到 runner 环境配置。
    const profileId = typeof body.profileId === 'string' && body.profileId !== '' ? body.profileId : undefined
    const profile = profiles.resolve(profileId)
    const spawned = await runner.spawnRun({
      id: bindId,
      prompt: fullPrompt,
      mcpServers,
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(profile?.model === undefined ? {} : { model: profile.model }),
      ...(profile?.apiKey === undefined ? {} : { apiKey: profile.apiKey }),
      ...(profile?.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }),
      ...(Array.isArray(body.allowedTools)
        ? { allowedTools: body.allowedTools.filter((tool): tool is string => typeof tool === 'string') }
        : {}),
      ...(cwd === undefined ? {} : { cwd }),
    })
    return reply.code(202).send({
      runId: spawned.sessionId,
      sessionId: spawned.sessionId,
      status: spawned.handle.info.status,
      ...(workflowId === undefined ? {} : { workflowId, ...(instanceId === undefined ? {} : { instance: instanceId }), ...(planId === undefined ? {} : { planId }) }),
    })
  })

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const handle = runner.get(request.params.id)
    if (handle === undefined) {
      return reply.code(404).send({ error: 'run not found' })
    }
    return handle.info
  })

  // 画布「执行」把用户的一句话追加进正在跑的会话（纯文本 → UserMessage 适配）。
  app.post<{ Params: { id: string } }>('/api/runs/:id/steer', async (request, reply) => {
    const body = asRecord(request.body)
    const text = typeof body.text === 'string' ? body.text : ''
    if (text.trim() === '') {
      return reply.code(400).send({ error: 'text is required' })
    }
    const handle = runner.get(request.params.id)
    if (handle === undefined) {
      return reply.code(404).send({ error: 'run not found' })
    }
    handle.steer(createUserMessage({ content: [{ type: 'text', text }] }))
    return reply.code(202).send({
      ok: true,
      runId: handle.info.sessionId,
      status: handle.info.status,
    })
  })

  // ── 统一审批中心（SDK 路径，AF_APPROVALS=1）──────────────────────
  app.get('/api/approvals/pending', async () => ({
    enabled: approvals !== undefined,
    pending: approvals?.listPending() ?? [],
  }))
  app.get('/api/approvals/history', async () => ({
    enabled: approvals !== undefined,
    history: approvals?.history() ?? [],
  }))
  app.post<{ Params: { id: string } }>('/api/approvals/:id/decide', async (request, reply) => {
    if (approvals === undefined) {
      return reply.code(409).send({ error: 'approvals disabled (set AF_APPROVALS=1)' })
    }
    const body = asRecord(request.body)
    const decision = body.decision
    if (decision !== 'approve' && decision !== 'deny') {
      return reply.code(400).send({ error: "decision must be 'approve' or 'deny'" })
    }
    const reason = typeof body.reason === 'string' && body.reason !== '' ? body.reason : undefined
    if (!approvals.decide(request.params.id, decision, reason)) {
      return reply.code(404).send({ error: 'approval not found or already decided' })
    }
    return reply.code(202).send({ ok: true, id: request.params.id, decision })
  })

  // ── llm_profiles 目录（只读；key 永不出现在回执里）───────────────
  app.get('/api/profiles', async () => ({
    file: profiles.file,
    revision: profiles.revision,
    profiles: profiles.list(),
  }))

  app.addHook('onClose', async () => {
    runner.closeAll()
    context.disposeAll()
    profiles.close()
  })

  return { app, ctx: context, repository, settings, runs, runner, dataDir }
}

/** 装配并监听。 */
export async function startServer(
  options: ServerOptions = {},
): Promise<FlowdServer> {
  const server = await buildServer(options)
  const parsedPort = Number(process.env.AF_PORT ?? 8899)
  const port = options.port ?? (Number.isFinite(parsedPort) ? parsedPort : 8899)
  const host = options.host ?? process.env.AF_HOST ?? '127.0.0.1'
  await server.app.listen({ port, host })
  return server
}

/** 上游 RPC 注册面 → Fastify POST 路由。 */
function createConnection(app: FastifyInstance): FlowdConnection {
  return {
    fetch: {
      register(route: FlowdFetchRoute): Disposer {
        app.post(route.path, async (request, reply) => forward(route, request, reply))
        // Fastify 没有逐路由反注册；服务整体关闭时路由随之消失。
        return () => {}
      },
    },
  }
}

/** 把 Fastify 请求重建成标准 Request，交给上游的 `serve`。 */
async function forward(
  route: FlowdFetchRoute,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const body = bodyText(request.body)
  const headers = new Headers()
  const contentType = request.headers['content-type']
  if (typeof contentType === 'string') headers.set('content-type', contentType)
  const rebuilt = new Request(`http://127.0.0.1${route.path}`, {
    method: 'POST',
    headers,
    body,
  })
  let response: Response
  try {
    response = await route.fetch(rebuilt)
  } catch (error) {
    return reply
      .code(500)
      .send({ error: error instanceof Error ? error.message : String(error) })
  }
  const text = await response.text()
  const responseType = response.headers.get('content-type')
  if (responseType !== null) reply.type(responseType)
  return reply.code(response.status).send(text)
}

function bodyText(body: unknown): string {
  if (body === undefined || body === null) return ''
  if (typeof body === 'string') return body
  return JSON.stringify(body)
}

/** 最小的工具注册表：只把 spec 收进内存（flowd 不向模型暴露注册表）。 */
function createToolsRegistry(): ToolsService {
  const tools = new Map<string, unknown>()
  return {
    register(spec) {
      tools.set(spec.name, spec)
      return () => {
        tools.delete(spec.name)
      }
    },
  }
}

/** 上游按包名找版本；flowd 的包名不同，找不到时退回落款。 */
function packageVersion(): string {
  const version = pluginVersion()
  return version === '' ? 'aegisforge-flowd' : version
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
