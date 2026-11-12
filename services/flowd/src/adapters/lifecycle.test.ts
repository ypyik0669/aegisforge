import { describe, expect, it } from 'vitest'
import type { RunInfo } from './runner.ts'
import { formatRunNotice, readNotifyChannels, sendRunNotice } from './notify.ts'
import { createMirrorSender, isTerminalStatus, toMirror, type WorkflowRunMirror } from './mirror.ts'

const runInfo = (overrides: Partial<RunInfo> = {}): RunInfo => ({
  id: 'run-1',
  sessionId: 'run-1',
  status: 'done',
  model: 'claude-sonnet-4-6',
  prompt: '跑一遍 pj 全链路并出报告',
  cwd: 'C:/tmp',
  allowedTools: [],
  startedAt: '2026-11-12T10:00:00.000Z',
  updatedAt: '2026-11-12T10:05:00.000Z',
  turns: 3,
  result: 'PJ-E2E-CHAIN-OK',
  ...overrides,
})

/** 记录每次 fetch 的 URL + body，按 URL 子串返回固定状态码。 */
function mockFetch(routes: Array<[string, number]>) {
  const calls: Array<{ url: string; body: unknown }> = []
  const impl = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: JSON.parse(init?.body ?? '{}') })
    const hit = routes.find(([needle]) => url.includes(needle))
    const status = hit === undefined ? 500 : hit[1]
    return { ok: status < 400, status, text: async () => '' } as Response
  }) as unknown as typeof fetch
  return { calls, impl }
}

describe('notify', () => {
  it('readNotifyChannels 只收非空环境变量', () => {
    const channels = readNotifyChannels({
      AF_NOTIFY_DINGTALK: 'https://oapi.dingtalk.com/robot/send?access_token=a',
      AF_NOTIFY_FEISHU: '',
      AF_NOTIFY_TG_CHAT_ID: '42',
    })
    expect(channels.dingtalk).toContain('access_token=a')
    expect(channels.feishu).toBeUndefined()
    expect(channels.telegramChatId).toBe('42')
    expect(channels.telegram).toBeUndefined()
  })

  it('formatRunNotice 汇总终态信息并截断长文本', () => {
    const text = formatRunNotice(runInfo({ prompt: 'x'.repeat(500) }))
    expect(text).toContain('flowd 运行完成')
    expect(text).toContain('run=run-1')
    expect(text.length).toBeLessThan(300)
  })

  it('sendRunNotice 按渠道各发一条，payload 形状与各平台一致', async () => {
    const { calls, impl } = mockFetch([
      ['dingtalk.com', 200],
      ['feishu.cn', 200],
      ['sendMessage', 200],
      ['example.com/hook', 200],
    ])
    const results = await sendRunNotice(
      {
        dingtalk: 'https://oapi.dingtalk.com/robot/send?access_token=a',
        feishu: 'https://open.feishu.cn/open-apis/bot/v2/hook/b',
        telegram: 'tok',
        telegramChatId: '42',
        generic: 'https://example.com/hook',
      },
      runInfo(),
      impl,
    )
    expect(results).toEqual(['dingtalk', 'ok', 'feishu', 'ok', 'telegram', 'ok', 'webhook', 'ok'])
    expect(calls.find((call) => call.url.includes('dingtalk'))?.body).toMatchObject({ msgtype: 'text' })
    expect(calls.find((call) => call.url.includes('feishu'))?.body).toMatchObject({ msg_type: 'text' })
    expect(calls.find((call) => call.url.includes('sendMessage'))?.url).toContain('bottok/sendMessage')
    expect(calls.find((call) => call.url.includes('example.com/hook'))?.body).toMatchObject({
      run: { id: 'run-1', status: 'done' },
    })
  })

  it('单渠道失败不影响其它渠道，失败以错误串回执', async () => {
    const { impl } = mockFetch([
      ['dingtalk.com', 200],
      ['example.com/hook', 500],
    ])
    const results = await sendRunNotice(
      {
        dingtalk: 'https://oapi.dingtalk.com/robot/send',
        generic: 'https://example.com/hook',
      },
      runInfo({ status: 'failed', error: 'boom' }),
      impl,
    )
    expect(results).toEqual(['dingtalk', 'ok', 'webhook', 'HTTP 500: '])
  })
})

describe('mirror', () => {
  it('toMirror 产出 workflow_runs 字段子集', () => {
    const mirror = toMirror(runInfo(), { id: 'wf-1', name: 'pojia-fullflow' })
    expect(mirror).toMatchObject({
      id: 'run-1',
      runtime: 'sdk',
      status: 'done',
      model_profile: 'claude-sonnet-4-6',
      workflow_id: 'wf-1',
      workflow_name: 'pojia-fullflow',
      started_at: '2026-11-12T10:00:00.000Z',
      updated_at: '2026-11-12T10:05:00.000Z',
    })
  })

  it('isTerminalStatus 只认 done/failed/stopped', () => {
    expect(isTerminalStatus('done')).toBe(true)
    expect(isTerminalStatus('failed')).toBe(true)
    expect(isTerminalStatus('stopped')).toBe(true)
    expect(isTerminalStatus('running')).toBe(false)
    expect(isTerminalStatus('starting')).toBe(false)
  })

  it('未配置 url 时是 no-op', async () => {
    const sender = createMirrorSender(undefined)
    expect(await sender.send(runInfo())).toBe(false)
  })

  it('运行中状态不投递；终态 POST 镜像行', async () => {
    const calls: WorkflowRunMirror[] = []
    const impl = (async (_url: string, init?: { body?: string }) => {
      calls.push(JSON.parse(init?.body ?? '{}') as WorkflowRunMirror)
      return { ok: true, status: 200, text: async () => '' } as Response
    }) as unknown as typeof fetch
    const sender = createMirrorSender('https://go.example.com/api/mirror/workflow-runs', impl)
    expect(await sender.send(runInfo({ status: 'running' }))).toBe(false)
    expect(calls).toHaveLength(0)
    expect(await sender.send(runInfo({ status: 'failed' }))).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].status).toBe('failed')
  })

  it('HTTP 失败与网络异常都返回 false 并记日志', async () => {
    const logs: string[] = []
    const bad = (async () => ({ ok: false, status: 503, text: async () => '' }) as Response) as unknown as typeof fetch
    const sender = createMirrorSender('https://go.example.com/api/mirror/workflow-runs', bad, (line) => logs.push(line))
    expect(await sender.send(runInfo())).toBe(false)
    expect(logs.some((line) => line.includes('503'))).toBe(true)
    const broken = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const sender2 = createMirrorSender('https://go.example.com/api/mirror/workflow-runs', broken, (line) => logs.push(line))
    expect(await sender2.send(runInfo())).toBe(false)
    expect(logs.some((line) => line.includes('ECONNREFUSED'))).toBe(true)
  })
})
