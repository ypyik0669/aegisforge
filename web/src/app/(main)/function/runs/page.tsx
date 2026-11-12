"use client";

import * as React from "react";

import { ChevronLeftIcon, ChevronRightIcon, HistoryIcon, Loader2Icon, RadioTowerIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import type { FlowdRunRow, WorkflowRunRow } from "@/lib/types";
import { flowdFetch } from "@/workflow-lite/flowdRpc";
import { cn } from "@/lib/utils";

function fmtTime(ts: string | null | undefined) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function truncate(s: string, maxLen: number): string {
  const first = s.replace(/\s+/g, " ").trim();
  if (first.length <= maxLen) return first;
  return first.slice(0, maxLen) + "…";
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  running: "default",
  done: "secondary",
  failed: "destructive",
  stopped: "outline",
  starting: "outline",
};
const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  done: "完成",
  failed: "失败",
  stopped: "已停止",
  starting: "启动中",
};

// One display row: a PG mirror row, or a live flowd row not yet mirrored.
interface RunDisplayRow {
  id: string;
  runtime: string;
  status: string;
  workflowId: string;
  workflowName: string;
  modelProfile: string;
  startedAt: string | null;
  finishedAt: string | null;
  live: boolean;
  prompt?: string;
  pg?: WorkflowRunRow;
  flowd?: FlowdRunRow;
}

const PAGE_SIZES = [25, 50, 100];
const LIVE_POLL_MS = 10_000;

export default function RunsPage() {
  const [page, setPage] = React.useState(0);
  const [size, setSize] = React.useState(50);
  const [runtimeFilter, setRuntimeFilter] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("");

  const [pgRuns, setPgRuns] = React.useState<WorkflowRunRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(false);

  // Live flowd runs, merged over the PG list (running SDK runs are not mirrored
  // until they terminate, so without this overlay they'd be invisible).
  const [liveRuns, setLiveRuns] = React.useState<FlowdRunRow[]>([]);

  const [selected, setSelected] = React.useState<RunDisplayRow | null>(null);

  React.useEffect(() => {
    setPage(0);
  }, [runtimeFilter, statusFilter, size]);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .workflowRuns({ runtime: runtimeFilter || undefined, status: statusFilter || undefined, page, size })
      .then((r) => {
        if (!alive) return;
        setPgRuns(r.runs ?? []);
        setTotal(r.total ?? 0);
      })
      .catch(() => {
        if (!alive) return;
        setPgRuns([]);
        setTotal(0);
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [page, size, runtimeFilter, statusFilter]);

  React.useEffect(() => {
    let alive = true;
    const poll = () => {
      flowdFetch("/api/runs", { method: "GET" })
        .then((r) => (r.ok ? r.json() : { runs: [] }))
        .then((j: { runs?: FlowdRunRow[] }) => {
          if (alive) setLiveRuns(j.runs ?? []);
        })
        .catch(() => {
          if (alive) setLiveRuns([]);
        });
    };
    poll();
    const t = setInterval(poll, LIVE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Merge: PG rows authoritative (live status overrides when the same run is
  // still tracked by flowd), flowd-only rows appended on top.
  const rows: RunDisplayRow[] = React.useMemo(() => {
    const liveById = new Map(liveRuns.map((r) => [r.id, r]));
    const pgRows: RunDisplayRow[] = pgRuns.map((pg) => {
      const live = liveById.get(pg.id);
      return {
        id: pg.id,
        runtime: pg.runtime,
        status: live ? live.status : pg.status,
        workflowId: pg.workflow_id,
        workflowName: pg.workflow_name,
        modelProfile: live ? live.model : pg.model_profile,
        startedAt: live ? live.startedAt : pg.started_at,
        finishedAt: pg.finished_at,
        live: live !== undefined,
        prompt: live?.prompt,
        pg,
        flowd: live,
      };
    });
    const liveOnly: RunDisplayRow[] = liveRuns
      .filter((r) => !pgRuns.some((pg) => pg.id === r.id))
      .map((r) => ({
        id: r.id,
        runtime: "sdk",
        status: r.status,
        workflowId: "",
        workflowName: "",
        modelProfile: r.model,
        startedAt: r.startedAt,
        finishedAt: null,
        live: true,
        prompt: r.prompt,
        flowd: r,
      }));
    return [...liveOnly, ...pgRows];
  }, [pgRuns, liveRuns]);

  const totalPages = Math.max(1, Math.ceil(total / size));
  const rangeStart = total === 0 ? 0 : page * size + 1;
  const rangeEnd = page * size + pgRuns.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <HistoryIcon className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl font-semibold tracking-tight">运行记录</h1>
          <Badge variant="secondary">{total + liveRuns.filter((r) => !pgRuns.some((p) => p.id === r.id)).length}</Badge>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={runtimeFilter || "all"} onValueChange={(v) => setRuntimeFilter(v === "all" ? "" : v)}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue placeholder="运行时" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部运行时</SelectItem>
            <SelectItem value="sdk">SDK</SelectItem>
            <SelectItem value="go">Go</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter || "all"} onValueChange={(v) => setStatusFilter(v === "all" ? "" : v)}>
          <SelectTrigger size="sm" className="w-36">
            <SelectValue placeholder="状态" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="running">运行中</SelectItem>
            <SelectItem value="done">完成</SelectItem>
            <SelectItem value="failed">失败</SelectItem>
            <SelectItem value="stopped">已停止</SelectItem>
          </SelectContent>
        </Select>
        <Select value={String(size)} onValueChange={(v) => setSize(Number(v))}>
          <SelectTrigger size="sm" className="w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} / 页
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <RadioTowerIcon className="size-3.5" />
          <span>{liveRuns.filter((r) => r.status === "running" || r.status === "starting").length} 个实时运行</span>
          <span className="tabular-nums">
            {rangeStart}–{rangeEnd} / {total}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={page <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeftIcon />
          </Button>
          <span className="tabular-nums">
            {page + 1} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>

      {/* Runs table */}
      <div className="flex h-[calc(100vh-13rem)] min-h-0 flex-col">
        <Card className="flex min-h-0 flex-1 flex-col overflow-hidden py-0">
          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="w-[140px]">开始时间</TableHead>
                  <TableHead className="w-[70px]">运行时</TableHead>
                  <TableHead className="w-[180px]">工作流 / Run</TableHead>
                  <TableHead>概要</TableHead>
                  <TableHead className="w-[110px]">模型</TableHead>
                  <TableHead className="w-[90px]">状态</TableHead>
                  <TableHead className="w-[140px]">结束时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && pgRuns.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-12 text-center">
                      <Loader2Icon className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-12 text-center text-sm text-muted-foreground">
                      暂无运行记录（SDK 运行终态后会镜像进这里）
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => (
                    <TableRow
                      key={row.id}
                      className={cn("cursor-pointer", selected?.id === row.id && "bg-accent hover:bg-accent")}
                      onClick={() => setSelected(row)}
                    >
                      <TableCell className="text-xs text-muted-foreground tabular-nums">
                        {fmtTime(row.startedAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs font-mono uppercase">
                          {row.runtime}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[180px]">
                        {row.workflowName || row.workflowId ? (
                          <div className="truncate text-xs">
                            {row.workflowName || row.workflowId}
                          </div>
                        ) : (
                          <code className="block truncate font-mono text-xs text-muted-foreground">{row.id}</code>
                        )}
                      </TableCell>
                      <TableCell className="max-w-0">
                        <code className="block truncate font-mono text-xs">
                          {row.prompt
                            ? truncate(row.prompt, 90)
                            : [row.workflowId, row.id].filter(Boolean).join(" · ")}
                        </code>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="max-w-[110px] truncate text-xs font-mono">
                          {row.modelProfile || "-"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <span className="inline-flex items-center gap-1">
                          <Badge variant={STATUS_VARIANT[row.status] ?? "outline"} className="text-xs">
                            {STATUS_LABEL[row.status] ?? row.status}
                          </Badge>
                          {row.live && (
                            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" aria-label="live" />
                          )}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground tabular-nums">
                        {fmtTime(row.finishedAt)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      </div>

      {/* Detail sheet */}
      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {selected && (
            <div className="mt-4 space-y-4">
              <SheetHeader>
                <SheetTitle className="break-all font-mono text-sm">{selected.id}</SheetTitle>
                <SheetDescription>
                  {selected.live ? "实时（flowd 会话）" : "镜像（PostgreSQL workflow_runs）"}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-2 text-sm">
                {[
                  ["运行时", selected.runtime.toUpperCase()],
                  ["状态", STATUS_LABEL[selected.status] ?? selected.status],
                  ["工作流", selected.workflowName || selected.workflowId || "-"],
                  ["模型", selected.modelProfile || "-"],
                  ["开始", fmtTime(selected.startedAt)],
                  ["结束", fmtTime(selected.finishedAt)],
                  ["会话 cwd", selected.flowd?.cwd ?? "-"],
                  ["轮次", selected.flowd ? String(selected.flowd.turns) : "-"],
                ].map(([k, v]) => (
                  <div key={k} className="flex gap-3">
                    <span className="w-20 shrink-0 text-muted-foreground">{k}</span>
                    <span className="min-w-0 break-all">{v}</span>
                  </div>
                ))}
              </div>
              {selected.prompt && (
                <div className="space-y-1">
                  <div className="text-xs text-muted-foreground">Prompt</div>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-xs">
                    {selected.prompt}
                  </pre>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
