/**
 * dsh-client-connection 的最小 shim：RPC 信封解析与 rpcId 类型。
 *
 * 上游用 schemastery 做校验；这里只手写字段检查，形状一致：
 * `{ type: 'client-request', rpcId: string, method: string, payload: unknown }`。
 */

/** 解码后的 client-request 信封。 */
export interface ClientRequestEnvelope {
  type: 'client-request'
  rpcId: string
  method: string
  payload: unknown
}

/** 解析结果（与 schemastery 的 `safeParse` 同形）。 */
export type ClientRequestParse =
  | { success: true; data: ClientRequestEnvelope }
  | { success: false }

/** 最小 schema 对象：只实现 rpc.ts 用到的 `safeParse`。 */
export const clientRequestSchema: {
  safeParse(value: unknown): ClientRequestParse
} = {
  safeParse(value: unknown): ClientRequestParse {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { success: false }
    }
    const record = value as Record<string, unknown>
    if (record.type !== 'client-request') return { success: false }
    if (typeof record.rpcId !== 'string' || record.rpcId === '') return { success: false }
    if (typeof record.method !== 'string' || record.method === '') return { success: false }
    return {
      success: true,
      data: {
        type: 'client-request',
        rpcId: record.rpcId,
        method: record.method,
        payload: record.payload,
      },
    }
  },
}

/** rpcId 的构造（上游是品牌类型；flowd 侧只需要原样回写）。 */
export function RpcId(id: string): string {
  return id
}
