/**
 * flowd 的统一审批中心（SDK 路径的审批队列）。
 *
 * 设计点：双路径同一套审批语义。Go 全服务器路径走 guard 的 intercept_pending
 * （DB 表 + web 审批中心页）；SDK 路径的副作用工具原本 deny-by-default，这里
 * 在 canUseTool 的 deny 分支前插一道审批队列：工具调用挂起等人在
 * `POST /api/approvals/:id/decide` 上裁决，超时视为拒绝。
 *
 * 审批记录同时追加写 `dataDir/approvals.jsonl` 审计（approve/deny/timeout
 * 都落一条），与 Go 侧 intercept 的审计语义对齐。
 *
 * 开关：`AF_APPROVALS=1` 启用（server.ts 只在开启时把 gate 接进 runner）；
 * `AF_APPROVAL_TIMEOUT_MS` 默认 300000（5 分钟），超时自动拒绝并注明原因。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'timeout'

/** 一条审批请求（API 回执形状）。 */
export interface ApprovalRequest {
  id: string
  sessionId: string
  tool: string
  /** 入参摘要（截断，防大 payload 刷屏）。 */
  inputPreview: string
  createdAt: string
  status: ApprovalStatus
  decidedAt?: string
  reason?: string
}

interface InternalRequest extends ApprovalRequest {
  resolve: (approved: boolean, reason: string) => void
  timer: ReturnType<typeof setTimeout>
}

const INPUT_PREVIEW_CHARS = 400

/** SDK canUseTool 的裁决形状（与 @anthropic-ai/claude-agent-sdk 对齐）。 */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

export class ApprovalQueue {
  private readonly pending = new Map<string, InternalRequest>()
  private readonly finished: ApprovalRequest[] = []
  private readonly auditFile: string
  private readonly timeoutMs: number
  private readonly log: (line: string) => void

  constructor(options: { dataDir: string; timeoutMs?: number; log?: (line: string) => void }) {
    this.auditFile = join(options.dataDir, 'approvals.jsonl')
    this.timeoutMs = options.timeoutMs ?? 300_000
    this.log = options.log ?? (() => {})
  }

  /** 挂起一次工具调用，等人裁决；超时按拒绝处理。 */
  request(sessionId: string, tool: string, input: Record<string, unknown>): Promise<PermissionDecision> {
    const id = randomUUID()
    const inputPreview =
      JSON.stringify(input)?.slice(0, INPUT_PREVIEW_CHARS) ?? '(unserializable input)'
    return new Promise<PermissionDecision>((resolve) => {
      const settled = (status: ApprovalStatus, approved: boolean, reason: string) => {
        this.pending.delete(id)
        const now = new Date().toISOString()
        const record: ApprovalRequest = {
          id,
          sessionId,
          tool,
          inputPreview,
          createdAt,
          status,
          decidedAt: now,
          reason,
        }
        this.finished.push(record)
        this.audit(record)
        this.log(`[flowd] approval ${status}: tool=${tool} id=${id} (${reason})`)
        resolve(
          approved
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: `工具 ${tool} 被审批中心${status === 'timeout' ? '超时' : '拒绝'}：${reason}` },
        )
      }
      const createdAt = new Date().toISOString()
      const timer = setTimeout(() => {
        settled('timeout', false, `等待 ${Math.round(this.timeoutMs / 1000)}s 无人裁决`)
      }, this.timeoutMs)
      const entry: InternalRequest = {
        id,
        sessionId,
        tool,
        inputPreview,
        createdAt,
        status: 'pending',
        timer,
        resolve: (approved, reason) => {
          clearTimeout(timer)
          settled(approved ? 'approved' : 'denied', approved, reason)
        },
      }
      this.pending.set(id, entry)
      this.log(`[flowd] approval pending: tool=${tool} id=${id} session=${sessionId}`)
    })
  }

  /** 待裁决列表（API 用）。 */
  listPending(): ApprovalRequest[] {
    return [...this.pending.values()].map(({ resolve, timer: _timer, ...rest }) => rest)
  }

  /** 已裁决历史（本次进程生命周期内）。 */
  history(): ApprovalRequest[] {
    return [...this.finished]
  }

  /** 裁决；返回 false = id 不存在或已裁决。 */
  decide(id: string, decision: 'approve' | 'deny', reason?: string): boolean {
    const entry = this.pending.get(id)
    if (entry === undefined) return false
    entry.resolve(decision === 'approve', reason ?? (decision === 'approve' ? '人工批准' : '人工拒绝'))
    return true
  }

  private audit(record: ApprovalRequest): void {
    try {
      mkdirSync(dirname(this.auditFile), { recursive: true })
      appendFileSync(this.auditFile, `${JSON.stringify(record)}\n`, 'utf8')
    } catch {
      // 审计盘不可写不该拖死审批主流程。
    }
  }
}

/** 造审批队列。 */
export function createApprovalQueue(options: {
  dataDir: string
  timeoutMs?: number
  log?: (line: string) => void
}): ApprovalQueue {
  return new ApprovalQueue(options)
}
