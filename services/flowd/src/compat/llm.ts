/**
 * dsh-llm 的最小 shim：只覆盖 vendored host 代码实际用到的成员。
 *
 * - `ContentBlock`：工具渲染结果只用到文本块。
 * - `createUserMessage` / `boundContextSummary` / `ContextFormed`：notice 投递用的用户消息。
 * - `MessageSourceMap`：上游用模块合并登记消息来源；这里保留同样的形状，
 *   runner 侧只关心文本，来源信息原样挂在消息上。
 */

/** 工具渲染能看到的内容块（当前只有文本）。 */
export type ContentBlock = { type: 'text'; text: string }

/** 一段被绑定进消息来源的上下文摘要（具体结构由宿主任意解释）。 */
export interface ContextFormed {
  text: string
}

/** 消息来源登记表（上游的模块合并点）。 */
export interface MessageSourceMap {
  'workflow-lite': { kind: 'workflow-lite' } & ContextFormed
}

/** 一条用户消息的来源描述。 */
export interface MessageSource {
  kind: string
  form?: string
  summary?: ContextFormed
}

/** 一条用户角色消息。 */
export interface UserMessage {
  content: ContentBlock[]
  source?: MessageSource
  /** 可选的一句摘要（上游 steer 的入参形状；runner 只取正文）。 */
  summary?: string
}

/** 把纯文本包成「已绑定上下文摘要」——保持上游调用点的形状。 */
export function boundContextSummary(summary: string): ContextFormed {
  return { text: summary }
}

/** 造一条用户消息；参数形状与上游一致。 */
export function createUserMessage(input: {
  content: ContentBlock[]
  source?: MessageSource
  summary?: string
}): UserMessage {
  return {
    content: input.content,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
  }
}

/** 取出一条用户消息里的纯文本（runner 投递给 SDK 时用）。 */
export function userMessageText(message: UserMessage): string {
  return message.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .filter((text) => text !== '')
    .join('\n')
}
