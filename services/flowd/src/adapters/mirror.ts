/**
 * run 终态 → PG 镜像客户端。
 *
 * 一致性设计（计划里的口径）：state.yaml 是运行态 SSOT，run 到终态后异步
 * 镜像进 PG `workflow_runs`，UI 列表以 PG 为准。flowd 不直连 PG（依赖面最小），
 * POST 给 Go 基座的 `AF_MIRROR_URL`（全服务器路径下是 /api/mirror/workflow-runs；
 * standalone 部署不配这个变量，镜像静默关闭）。
 *
 * 至少一次投递：失败不重试队列（standalone 无持久化），但终态幂等
 * （Go 侧按 run_id upsert），丢了重新跑一次 run 也不会漂。
 */

import type { RunInfo } from './runner.ts'

/** workflow_runs 的一行镜像（db/schema.sql:1577 的字段子集）。 */
export interface WorkflowRunMirror {
  id: string
  runtime: 'sdk' | 'go'
  status: string
  model_profile?: string
  workflow_id?: string
  workflow_name?: string
  started_at: string
  updated_at: string
}

/** RunInfo → 镜像行（终态收敛：done|failed|stopped → 同名小写）。 */
export function toMirror(info: RunInfo, workflow?: { id: string; name?: string }): WorkflowRunMirror {
  return {
    id: info.id,
    runtime: 'sdk',
    status: info.status,
    ...(info.model === undefined ? {} : { model_profile: info.model }),
    ...(workflow === undefined ? {} : { workflow_id: workflow.id, ...(workflow.name === undefined ? {} : { workflow_name: workflow.name }) }),
    started_at: info.startedAt,
    updated_at: info.updatedAt,
  }
}

/** 终态才镜像；运行中的状态以 state.yaml 为准，不值得投。 */
export function isTerminalStatus(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'stopped'
}

export interface MirrorSender {
  send(info: RunInfo, workflow?: { id: string; name?: string }): Promise<boolean>
}

/** 造一个镜像发送端；url 未配 → 永远 no-op false。AF_MIRROR_TOKEN 配了就带上
 * （Go 基座 fail-closed：没 token 一律 401）。 */
export function createMirrorSender(
  url: string | undefined,
  fetchImpl: typeof fetch = fetch,
  log: (line: string) => void = () => {},
  token: string | undefined = process.env.AF_MIRROR_TOKEN,
): MirrorSender {
  if (url === undefined || url === '') {
    return { send: async () => false }
  }
  return {
    async send(info, workflow) {
      if (!isTerminalStatus(info.status)) return false
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token === undefined || token === '' ? {} : { 'x-mirror-token': token }),
          },
          body: JSON.stringify(toMirror(info, workflow)),
        })
        if (!response.ok) {
          log(`[flowd] mirror POST failed: HTTP ${String(response.status)}`)
          return false
        }
        return true
      } catch (error) {
        log(`[flowd] mirror POST error: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
  }
}
