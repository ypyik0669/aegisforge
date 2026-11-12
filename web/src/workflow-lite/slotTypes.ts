/**
 * ARTEX 适配：DSH 槽位 props 的本地等价类型。
 *
 * 上游 `WorkflowView` 从 `@deepseek-ai/dsh-client-ui-slots` 只借了两个**纯类型**：
 * `PropsRuntime<'conversation.view'>`（槽位运行时注入的 `t` / `openView` / 可见性）
 * 与 `PropsLocale<typeof NS>`（把 `t` 收窄到本插件的文案键）。
 * 这里按实际用到的成员收窄成同样形状，运行时零依赖，视图代码不必改。
 */

import type { ReactNode } from "react";

import type { T } from "./i18n.ts";

/** 槽位给视图的运行时 props（仅保留本视图读取的字段）。 */
export interface PropsRuntime<_Slot extends string> {
  /** 文案函数（宿主 locale 注入；ARTEX 里由 mount.tsx 直接给 `zh`）。 */
  t: T;
  /** 切到宿主会话页的另一个 tab；ARTEX 没有对应 tab，mount 里传 no-op。 */
  openView(view: string, focus: string): void;
  hidden?: boolean;
  dim?: boolean;
  children?: ReactNode;
}

/** 槽位 locale props（与 `PropsRuntime` 的 `t` 相同，保留同名类型便于上游代码原样使用）。 */
export type PropsLocale<_NS extends string> = {
  t: T;
};
