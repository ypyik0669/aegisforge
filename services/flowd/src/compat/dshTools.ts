/**
 * dsh-tools 的最小 shim。
 *
 * 上游 `defineTool` 负责把 spec 收敛成带类型的工具定义；flowd 不做运行时注册表，
 * 这里用恒等函数保留 spec 形状，由 `FlowdContext.tools.register` 收进内存。
 */

import type { ContentBlock } from './llm.ts'
import type { JsonValue } from './util.ts'

/** `workflow_lite` 这类工具的定义形状（只覆盖 host 代码实际写的字段）。 */
export interface ToolDefinition<Args = unknown, Value = JsonValue> {
  name: string
  description: string
  parameters: Record<string, unknown>
  output?: {
    schema: Record<string, unknown>
    render: (args: Args, value: Value) => ContentBlock[]
  }
  execute: (args: Args, exec?: ToolExecView) => Promise<Value>
}

/** execute 可用的最小执行上下文（`ToolExecView` 结构上满足它）。 */
export interface ToolExecView {
  agent?: {
    session?: {
      header?: { id?: string; cwd?: string; origin?: string; parentSession?: string }
    }
  }
}

/** 恒等 shim：保留上游对象字面量与推断形状。 */
export function defineTool<Args, Value>(
  spec: ToolDefinition<Args, Value>,
): ToolDefinition<Args, Value> {
  return spec
}
