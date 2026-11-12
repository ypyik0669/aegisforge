/**
 * dsh-util-values 的最小替代：JSON 兼容值。
 *
 * 上游工具把返回值约束成 `JsonValue`；这里只定义形状，不做运行时校验。
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
