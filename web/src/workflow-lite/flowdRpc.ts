/**
 * ARTEX 适配：把画布的 typed RPC 载体落到 flowd 的 HTTP 面。
 *
 * 上游 `rpc.ts` 只要求一个按形状收窄的 {@link RpcCarrier}（`rpc.call(channel, endpoint, payload, signal)`）。
 * 这里用 fetch 实现它：
 * - URL：`${flowdBase}/api/workflow-lite/<endpoint>`（`channel` 为 `/api`，`endpoint` 为
 *   `workflow-lite/graph/list`，拼起来正好是 flowd 的 one-route-per-endpoint 路由）；
 * - `flowdBase` 默认同源 `/api/flowd`（Go 网关反代并剥离前缀后转发，带 JWT）；
 *   `NEXT_PUBLIC_FLOWD_BASE` 可改成直连 flowd（如 `http://127.0.0.1:8899`，此时不要再带 `/api/flowd`）；
 * - 信封：请求 `{type:'client-request', rpcId, method, payload}`，响应
 *   `{type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}`。
 *
 * @module aegisforge/web/workflow-lite/flowdRpc
 */

import { getToken } from '@/lib/api'

import {
  type ConnectionRpcResult,
  createWorkflowLiteRpc,
  requireRpcCarrier,
  type RpcCarrier,
  type WorkflowLiteRpc,
} from './rpc.ts'

/**
 * flowd 的浏览器侧基础路径（不带尾斜杠）。
 *
 * 默认 `/api/flowd`：同源经 Go 网关（`pkg/flowdproxy`）反代，网关会剥掉 `/api/flowd` 前缀，
 * flowd 收到 `/api/workflow-lite/...`。直连时把 `NEXT_PUBLIC_FLOWD_BASE` 设成 flowd 本体地址。
 */
export const FLOWD_BASE = (() => {
  const configured = process.env.NEXT_PUBLIC_FLOWD_BASE?.trim()
  const base = configured !== undefined && configured !== '' ? configured : '/api/flowd'
  return base.replace(/\/+$/u, '')
})()

/** 拼出 flowd 上的绝对/同源 URL（`path` 以 `/` 开头）。 */
export function flowdUrl(path: string): string {
  return `${FLOWD_BASE}${path.startsWith('/') ? path : `/${path}`}`
}

/**
 * 带 Bearer token 的 flowd fetch。token 与 ARTEX 其余接口同一份（localStorage `artex_token`）。
 * 401 不在这里跳登录：画布只把错误抛给调用方展示，避免整页被一个后台轮询踢走。
 */
export async function flowdFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = getToken()
  if (token !== null && token !== '') headers.set('authorization', `Bearer ${token}`)
  return fetch(flowdUrl(path), { ...init, headers })
}

/** 生成 RPC 信封的 id（浏览器有 `crypto.randomUUID`；没有时退化成时间戳 + 随机数）。 */
function newRpcId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }
  return `rpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/** 把任意值收窄成对象（信封解析用）。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** fetch 版 RPC 载体。 */
function createFlowdCarrier(): RpcCarrier {
  return {
    rpc: {
      async call(
        channel: string,
        endpoint: string,
        payload: unknown,
        signal?: AbortSignal,
      ): Promise<ConnectionRpcResult<unknown>> {
        // 上游 `rpcTarget()` 给的是 (`/api`, `workflow-lite/<endpoint>`)；拼成 flowd 的完整路由。
        const url = flowdUrl(`${channel}/${endpoint}`)
        const label = `workflow_lite rpc ${endpoint}`
        let response: Response
        try {
          response = await flowdFetch(`${channel}/${endpoint}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              type: 'client-request',
              rpcId: newRpcId(),
              method: endpoint,
              payload,
            }),
            ...(signal === undefined ? {} : { signal }),
          })
        } catch (error) {
          // AbortError 原样抛（调用方靠它区分取消）；其余网络错误补上目标地址。
          if (error instanceof DOMException && error.name === 'AbortError') throw error
          throw new Error(
            `${label}: 无法连接 flowd（${url}）：${error instanceof Error ? error.message : String(error)}`,
          )
        }

        const text = await response.text()
        let envelope: Record<string, unknown>
        try {
          envelope = asRecord(JSON.parse(text) as unknown)
        } catch {
          throw new Error(
            `${label}: 响应不是 JSON（HTTP ${String(response.status)}）：${text.slice(0, 200)}`,
          )
        }

        const result = asRecord(envelope.result)
        if (
          envelope.result === undefined ||
          envelope.result === null ||
          typeof envelope.result !== 'object'
        ) {
          throw new Error(
            `${label}: 响应缺少 result（HTTP ${String(response.status)}）：${text.slice(0, 200)}`,
          )
        }

        if (result.ok !== true) {
          const error = asRecord(result.error)
          return {
            ok: false,
            error: {
              code: typeof error.code === 'string' ? error.code : 'unknown',
              message:
                typeof error.message === 'string' && error.message !== ''
                  ? error.message
                  : `${label}: HTTP ${String(response.status)}`,
              ...(error.details === undefined ? {} : { details: error.details }),
            },
          }
        }
        return { ok: true, value: result.value }
      },
    },
  }
}

/** 建一个走 flowd 的画布 RPC 调用器。 */
export function createFlowdRpc(): WorkflowLiteRpc {
  return createWorkflowLiteRpc(requireRpcCarrier(createFlowdCarrier()))
}
