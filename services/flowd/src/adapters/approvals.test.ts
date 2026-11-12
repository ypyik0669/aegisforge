import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApprovalQueue, type ApprovalRequest } from './approvals.ts'

describe('ApprovalQueue', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowd-approvals-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const makeQueue = (timeoutMs?: number) =>
    new ApprovalQueue({ dataDir: dir, ...(timeoutMs === undefined ? {} : { timeoutMs }) })

  it('request → decide approve resolves allow with original input', async () => {
    const queue = makeQueue()
    const input = { command: 'ls -la', cwd: '/tmp' }
    const decision = queue.request('sess-1', 'Bash', input)
    const pending = queue.listPending()
    expect(pending).toHaveLength(1)
    expect(pending[0].tool).toBe('Bash')
    expect(pending[0].sessionId).toBe('sess-1')
    expect(queue.decide(pending[0].id, 'approve', '人工批准')).toBe(true)
    const result = await decision
    expect(result.behavior).toBe('allow')
    if (result.behavior === 'allow') expect(result.updatedInput).toEqual(input)
    const history = queue.history()
    expect(history).toHaveLength(1)
    expect(history[0].status).toBe('approved')
    expect(history[0].reason).toBe('人工批准')
  })

  it('request → decide deny resolves deny with message', async () => {
    const queue = makeQueue()
    const decision = queue.request('sess-1', 'Write', { path: 'x' })
    const pending = queue.listPending()
    expect(queue.decide(pending[0].id, 'deny', '不在白名单')).toBe(true)
    const result = await decision
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') expect(result.message).toContain('Write')
    expect(queue.history()[0].status).toBe('denied')
  })

  it('timeout counts as denial with timeout reason', async () => {
    const queue = makeQueue(60)
    const decision = queue.request('sess-1', 'Edit', { path: 'x' })
    const result = await decision
    expect(result.behavior).toBe('deny')
    if (result.behavior === 'deny') expect(result.message).toContain('超时')
    expect(queue.history()[0].status).toBe('timeout')
    expect(queue.listPending()).toHaveLength(0)
  })

  it('decide on unknown/already-decided id returns false', async () => {
    const queue = makeQueue()
    const decision = queue.request('sess-1', 'Bash', {})
    const pending = queue.listPending()
    expect(queue.decide('no-such-id', 'approve')).toBe(false)
    expect(queue.decide(pending[0].id, 'approve')).toBe(true)
    expect(queue.decide(pending[0].id, 'deny')).toBe(false)
    await decision
  })

  it('every settled decision is appended to the audit JSONL', async () => {
    const queue = makeQueue(60)
    const a = queue.request('s1', 'Bash', {})
    queue.decide(queue.listPending()[0].id, 'approve')
    await a
    const b = queue.request('s2', 'Write', {})
    await b
    const lines = readFileSync(join(dir, 'approvals.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as ApprovalRequest)
    expect(lines).toHaveLength(2)
    expect(lines[0].status).toBe('approved')
    expect(lines[1].status).toBe('timeout')
    // 审计行不该携带完整入参，只有截断摘要。
    expect(lines[0].inputPreview).toBeDefined()
  })

  it('listPending never exposes resolver internals', () => {
    const queue = makeQueue()
    queue.request('sess-1', 'Bash', { command: 'echo hi' })
    const raw = JSON.stringify(queue.listPending())
    expect(raw).not.toContain('resolve')
    expect(raw).not.toContain('timer')
  })
})
