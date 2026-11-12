/**
 * ARTEX 适配：画布「执行」用的会话桥，后端换成 flowd 的 REST 面。
 *
 * 上游 `app/sessions.ts` 的 `SessionBridge` 面向 DSH 宿主的会话服务；ARTEX 里的一等公民是
 * flowd 的一次 SDK run，所以把 run 当作「会话」：
 * - `rows()`：`GET /api/runs`（flowd 的 `runner.list()`，`{runs: RunInfo[]}`）映射成 `SessionRow`，
 *   3 秒轮询 + `subscribe` 推给视图；
 * - `deliver(session, text)`：已有 run 走新加的 `POST /api/runs/:id/steer`（纯文本），
 *   空串或不在列表里就 `POST /api/runs` 新建（prompt = text）；
 * - `create()`：返回空串，真正创建交给 `deliver`；
 * - `open(session)`：`/function/workflow?run=<id>`，由 mount 注入的导航回调完成；
 * - `available()` / `canCreate()`：启动时探一次 `/api/health`，可达即 true。
 *
 * @module aegisforge/web/workflow-lite/flowdSessions
 */

import type { SessionBridge, SessionRow } from './app/sessions.ts'
import { flowdFetch } from './flowdRpc.ts'

/** 会话列表轮询间隔。 */
const POLL_MS = 3000

/** flowd `GET /api/runs` 里的一条（只取画布要用的字段）。 */
interface FlowdRun {
  id?: string
  sessionId?: string
  status?: string
  prompt?: string
  cwd?: string
  updatedAt?: string
}

/** `{runs:[...]}` 回执。 */
interface FlowdRunsResponse {
  runs?: FlowdRun[]
}

/** 把 flowd 的 run 映射成画布的会话行。 */
function toRow(run: FlowdRun): SessionRow | null {
  const id = typeof run.sessionId === 'string' && run.sessionId !== '' ? run.sessionId : run.id
  if (typeof id !== 'string' || id === '') return null
  const prompt = typeof run.prompt === 'string' ? run.prompt.trim() : ''
  const status = typeof run.status === 'string' ? run.status : ''
  const updatedAt = typeof run.updatedAt === 'string' ? Date.parse(run.updatedAt) : Number.NaN
  return {
    id,
    title: prompt === '' ? id : prompt.slice(0, 40),
    running: status === 'starting' || status === 'running',
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    ...(typeof run.cwd === 'string' && run.cwd !== '' ? { cwd: run.cwd } : {}),
    blank: false,
    subagent: false,
  }
}

/** 同一份行数据就不换引用，让下游 `useSyncExternalStore` 不白渲染。 */
function sameRows(a: readonly SessionRow[], b: readonly SessionRow[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i]
    const right = b[i]
    if (left === undefined || right === undefined) return false
    if (
      left.id !== right.id ||
      left.title !== right.title ||
      left.running !== right.running ||
      left.updatedAt !== right.updatedAt ||
      left.blank !== right.blank ||
      left.subagent !== right.subagent
    ) {
      return false
    }
  }
  return true
}

/** 从非 OK 响应里读一条给人看的错误。 */
async function readError(response: Response, label: string): Promise<string> {
  let body = ''
  try {
    body = await response.text()
  } catch {
    body = ''
  }
  let message = body.slice(0, 300)
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown }
    if (typeof parsed.error === 'string') message = parsed.error
    else if (typeof parsed.message === 'string') message = parsed.message
  } catch {
    // 非 JSON：保留原始文本。
  }
  return message === '' ? `${label}: HTTP ${String(response.status)}` : message
}

/** 画布会话桥 + 生命周期（mount 在 effect 里 start/stop）。 */
export interface FlowdSessions extends SessionBridge {
  /** 探 health 并开始 3 秒轮询（幂等）。 */
  start(): void
  /** 停轮询（组件卸载时）。 */
  stop(): void
}

/**
 * 建会话桥。
 * @param onOpen - 打开某个 run 的导航回调（mount 用 next/navigation 的 router.push）。
 */
export function createFlowdSessions(onOpen?: (session: string) => void): FlowdSessions {
  let cache: readonly SessionRow[] = []
  let known = new Set<string>()
  let loadedOnce = false
  let healthy = false
  let timer: ReturnType<typeof setInterval> | null = null
  let inFlight: Promise<void> | null = null
  /** create() 预分配的会话 → 工作区；deliver 真正建 run 时带上。 */
  const pendingCwd = new Map<string, string>()
  const listeners = new Set<() => void>()

  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const refresh = (): Promise<void> => {
    if (inFlight !== null) return inFlight
    inFlight = (async () => {
      try {
        const response = await flowdFetch('/api/runs', {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return
        const body = (await response.json()) as FlowdRunsResponse
        const next = (Array.isArray(body.runs) ? body.runs : []).flatMap((run) => {
          const row = toRow(run)
          return row === null ? [] : [row]
        })
        known = new Set(next.map((row) => row.id))
        loadedOnce = true
        if (!sameRows(cache, next)) {
          cache = next
          emit()
        }
      } catch {
        // 轮询失败保持上一份数据，不打断画布。
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  const probe = async (): Promise<void> => {
    let reachable = false
    try {
      const response = await flowdFetch('/api/health', {
        headers: { accept: 'application/json' },
      })
      reachable = response.ok
    } catch {
      reachable = false
    }
    if (healthy !== reachable) {
      healthy = reachable
      emit()
    }
  }

  return {
    start() {
      if (timer !== null) return
      void probe()
      void refresh()
      timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        void refresh()
      }, POLL_MS)
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
    },
    available: () => healthy,
    canCreate: () => healthy,
    rows: () => cache,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async deliver(session, text) {
      // 还没轮到第一次轮询就先读一次，避免把已存在的 run 误判成新会话。
      if (!loadedOnce) await refresh()
      if (session === '' || !known.has(session)) {
        // 带 sessionId：flowd 用它当 SDK run 的会话 id（MCP 绑定与实例归属同址）。
        // cwd 跟会话行走（工作流实例的工作区）；create() 预分配的会话用暂存值。
        const cwd =
          cache.find((row) => row.id === session)?.cwd ?? pendingCwd.get(session)
        if (session !== '') pendingCwd.delete(session)
        const response = await flowdFetch('/api/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            prompt: text,
            ...(session !== '' ? { sessionId: session } : {}),
            ...(cwd === undefined ? {} : { cwd }),
          }),
        })
        if (!response.ok) throw new Error(await readError(response, '新建运行失败'))
        await refresh()
        return
      }
      const response = await flowdFetch(`/api/runs/${encodeURIComponent(session)}/steer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!response.ok) throw new Error(await readError(response, '向运行发送消息失败'))
      await refresh()
    },
    async create(_session, cwd) {
      // flowd 的 run 在 `deliver` 时才真正创建（需要 prompt）；这里先预分配
      // 会话 id——run/start 要拿它建实例（实例归属与 SDK 会话绑定同址），cwd
      // 暂存起来，deliver 建 run 时带上。
      const id = crypto.randomUUID()
      if (cwd !== undefined && cwd !== '') pendingCwd.set(id, cwd)
      return id
    },
    open(session) {
      if (onOpen === undefined) return false
      onOpen(session)
      return true
    },
  }
}
