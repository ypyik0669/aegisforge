"use client";

/**
 * 工作流画布（P1 移植）：全高挂载 workflow-lite 画布。
 *
 * `useSearchParams`（画布从 `?run=` 读当前实例）在静态导出预渲染时必须处于 Suspense 边界内，
 * 否则 Next 会要求整页转为动态渲染。
 */

import { Suspense } from "react";

import { WorkflowLiteCanvas } from "@/workflow-lite/mount";

export default function WorkflowPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
          正在加载工作流画布…
        </div>
      }
    >
      <WorkflowLiteCanvas />
    </Suspense>
  );
}
