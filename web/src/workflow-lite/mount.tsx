"use client";

/**
 * ARTEX 适配：替代上游 `index.ts` 的 DSH 槽位装配。
 *
 * 上游 `index.ts` 把视图挂到会话页的 `conversation.view` 槽位，并从宿主 `ctx` 取
 * connection / sessions / desktop。ARTEX 里没有这套槽位，于是这里直接：
 * - 用 {@link createFlowdRpc} 建 RPC（POST `/api/workflow-lite/<endpoint>`）；
 * - 用 {@link createFlowdSessions} 建会话桥（flowd `/api/runs`）；
 * - `sessionId` 从 URL `?run=` 读（没有就 undefined）；
 * - `desktop` 不注入（`WorkflowViewInjected.desktop` 本来就可选，文件「用其他程序打开」不显示）；
 * - 文案默认用 `zh`（上游 `i18n.ts` 同一份词典），`openView` 传 no-op。
 */

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo } from "react";

import { createFlowdRpc } from "./flowdRpc.ts";
import { createFlowdSessions } from "./flowdSessions.ts";
import { zh, type T } from "./i18n.ts";
import { WorkflowView } from "./ui/WorkflowView.tsx";

/** 工作流画布页面组件。 */
export function WorkflowLiteCanvas(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const run = searchParams.get("run");
  const sessionId = run !== null && run.trim() !== "" ? run : undefined;

  const rpc = useMemo(() => createFlowdRpc(), []);
  const sessions = useMemo(
    () =>
      createFlowdSessions((session) => {
        router.push(`/function/workflow?run=${encodeURIComponent(session)}`);
      }),
    [router],
  );

  useEffect(() => {
    sessions.start();
    return () => {
      sessions.stop();
    };
  }, [sessions]);

  const t = useMemo<T>(() => (key) => zh[key], []);
  // ARTEX 里没有「对话 / 工作流」tab 的切换；执行后不跳走。
  const openView = useCallback((_view: string, _focus: string): void => {}, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <WorkflowView rpc={rpc} sessionId={sessionId} sessions={sessions} t={t} openView={openView} />
      </div>
    </div>
  );
}
