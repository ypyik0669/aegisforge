"use client";

import * as React from "react";

import { CheckIcon, ClockIcon, RefreshCwIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { flowdFetch } from "@/workflow-lite/flowdRpc";
import { cn } from "@/lib/utils";

/**
 * SDK 路径的审批中心面板（flowd `AF_APPROVALS=1`）。
 *
 * Go 全服务器路径的审批在 `/system/intercept/approvals`（guard 的 DB 表）；
 * 这里对齐 Claude Agent SDK 路径：flowd 的 canUseTool 把非白名单副作用工具
 * 挂到审批队列，人在本页裁决（批准 / 拒绝），超时自动拒绝。
 * 数据源走 Go 网关的 flowd 反代（`/api/flowd/api/approvals/...`），同一份 JWT。
 */

interface FlowdApproval {
  id: string;
  sessionId: string;
  tool: string;
  inputPreview: string;
  createdAt: string;
  status: "pending" | "approved" | "denied" | "timeout";
  decidedAt?: string;
  reason?: string;
}

const STATUS_LABEL: Record<FlowdApproval["status"], string> = {
  pending: "待裁决",
  approved: "已批准",
  denied: "已拒绝",
  timeout: "超时",
};

const STATUS_VARIANT: Record<FlowdApproval["status"], "default" | "secondary" | "destructive" | "outline"> = {
  pending: "default",
  approved: "secondary",
  denied: "destructive",
  timeout: "outline",
};

function fmtTime(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ApprovalCard({ item, onDecide }: { item: FlowdApproval; onDecide: (id: string, decision: "approve" | "deny", reason?: string) => void }) {
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const decide = (decision: "approve" | "deny") => {
    setBusy(true);
    onDecide(item.id, decision, reason.trim() === "" ? undefined : reason.trim());
  };
  return (
    <Card className={cn(item.status === "pending" && "border-primary/40")}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-mono text-sm">
          <ShieldAlertIcon className="size-4 text-primary" aria-hidden />
          {item.tool}
        </CardTitle>
        <CardDescription className="font-mono text-xs">
          session {item.sessionId.slice(0, 8)} · {fmtTime(item.createdAt)}
        </CardDescription>
        <CardAction>
          <Badge variant={STATUS_VARIANT[item.status]}>{STATUS_LABEL[item.status]}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap break-all">
          {item.inputPreview}
        </pre>
        {item.status === "pending" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="裁决理由（可选）"
              className="h-8 max-w-xs text-xs"
              aria-label={`裁决理由 ${item.tool}`}
            />
            <Button size="sm" onClick={() => decide("approve")} disabled={busy} aria-busy={busy}>
              <CheckIcon aria-hidden /> 批准
            </Button>
            <Button size="sm" variant="destructive" onClick={() => decide("deny")} disabled={busy} aria-busy={busy}>
              <XIcon aria-hidden /> 拒绝
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {fmtTime(item.decidedAt)} · {item.reason ?? "—"}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function FlowdApprovals() {
  const [enabled, setEnabled] = React.useState<boolean | null>(null);
  const [pending, setPending] = React.useState<FlowdApproval[]>([]);
  const [history, setHistory] = React.useState<FlowdApproval[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const [pendingRes, historyRes] = await Promise.all([
        flowdFetch("/api/approvals/pending"),
        flowdFetch("/api/approvals/history"),
      ]);
      if (!pendingRes.ok || !historyRes.ok) {
        throw new Error(`HTTP ${String(pendingRes.status)} / ${String(historyRes.status)}`);
      }
      const pendingBody = (await pendingRes.json()) as { enabled?: boolean; pending?: FlowdApproval[] };
      const historyBody = (await historyRes.json()) as { enabled?: boolean; history?: FlowdApproval[] };
      setEnabled(pendingBody.enabled === true);
      setPending(pendingBody.pending ?? []);
      setHistory((historyBody.history ?? []).slice().reverse());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const decide = async (id: string, decision: "approve" | "deny", reason?: string) => {
    try {
      const res = await flowdFetch(`/api/approvals/${encodeURIComponent(id)}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, ...(reason === undefined ? {} : { reason }) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${String(res.status)}`);
      }
      toast.success(decision === "approve" ? "已批准" : "已拒绝");
    } catch (e) {
      toast.error(`裁决失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      void refresh();
    }
  };

  if (loading && enabled === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">SDK 审批中心</h2>
        <div className="flex items-center gap-2">
          {enabled === false && (
            <Badge variant="outline">未启用（flowd 需 AF_APPROVALS=1）</Badge>
          )}
          {pending.length > 0 && <Badge variant="destructive">{pending.length} 待裁决</Badge>}
          <Button variant="outline" size="sm" onClick={() => void refresh()} aria-label="刷新审批列表">
            <RefreshCwIcon className={cn("size-4", loading && "animate-spin")} aria-hidden /> 刷新
          </Button>
        </div>
      </div>

      {error !== null && (
        <p className="text-sm text-destructive" role="alert">
          无法连接 flowd 审批中心：{error}
        </p>
      )}

      <section aria-label="待裁决" className="space-y-3">
        {pending.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia>
                <ClockIcon aria-hidden />
              </EmptyMedia>
              <EmptyTitle>没有待裁决的工具调用</EmptyTitle>
              <EmptyDescription>
                SDK 会话里的副作用工具（写文件、执行命令等）会先挂到这里等你批准，超时自动拒绝。
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          pending.map((item) => <ApprovalCard key={item.id} item={item} onDecide={(id, d, r) => void decide(id, d, r)} />)
        )}
      </section>

      {history.length > 0 && (
        <section aria-label="裁决历史" className="space-y-3">
          <h3 className="text-sm font-medium text-muted-foreground">裁决历史（本次进程内）</h3>
          {history.map((item) => (
            <ApprovalCard key={item.id} item={item} onDecide={(id, d, r) => void decide(id, d, r)} />
          ))}
        </section>
      )}
    </div>
  );
}
