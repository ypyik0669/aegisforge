import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProfileStore, profilesFilePath } from './profiles.ts'

describe('ProfileStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowd-profiles-'))
    file = profilesFilePath(dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const write = (profiles: unknown[], revision = 1) => {
    writeFileSync(file, JSON.stringify({ revision, profiles }), 'utf8')
  }

  it('loads valid profiles and rejects malformed entries', () => {
    write([
      { id: 'deepseek', name: 'DeepSeek', format: 'openai', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', isDefault: true },
      { id: 'bad', name: '', format: 'anthropic' },
      { id: 'bad2', name: 'x', format: 'wat' },
      'nope',
    ])
    const store = new ProfileStore(file)
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0].id).toBe('deepseek')
    expect(store.list()[0].isDefault).toBe(true)
  })

  it('resolve(): explicit id wins, single default used when no id, disabled skipped', () => {
    write([
      { id: 'a', name: 'A', format: 'anthropic', model: 'm-a' },
      { id: 'b', name: 'B', format: 'anthropic', model: 'm-b', isDefault: true },
      { id: 'c', name: 'C', format: 'anthropic', model: 'm-c', isDefault: true, enabled: false },
    ])
    const store = new ProfileStore(file)
    expect(store.resolve('a')?.model).toBe('m-a')
    expect(store.resolve('c')).toBeUndefined()
    expect(store.resolve('missing')).toBeUndefined()
    // 两个 isDefault 候选（b 生效 c 禁用）→ 仍取唯一生效的那条。
    expect(store.resolve()?.model).toBe('m-b')
  })

  it('resolve(): no default → undefined (fall back to runner env)', () => {
    write([{ id: 'a', name: 'A', format: 'anthropic', model: 'm-a' }])
    const store = new ProfileStore(file)
    expect(store.resolve()).toBeUndefined()
  })

  it('apiKeyEnv resolves from process env; list() never leaks keys', () => {
    process.env.AF_TEST_PROFILE_KEY = 'sk-secret'
    write([
      { id: 'a', name: 'A', format: 'anthropic', apiKeyEnv: 'AF_TEST_PROFILE_KEY', model: 'm' },
      { id: 'b', name: 'B', format: 'anthropic', apiKey: 'sk-inline' },
    ])
    const store = new ProfileStore(file)
    expect(store.resolve('a')?.apiKey).toBe('sk-secret')
    expect(store.resolve('b')?.apiKey).toBe('sk-inline')
    const listed = JSON.stringify(store.list())
    expect(listed).not.toContain('sk-secret')
    expect(listed).not.toContain('sk-inline')
    expect(store.list()[0].apiKeySource).toBe('AF_TEST_PROFILE_KEY')
    delete process.env.AF_TEST_PROFILE_KEY
  })

  it('hot reload: external file change is picked up without restart', async () => {
    write([{ id: 'a', name: 'A', format: 'anthropic', model: 'm-1' }], 1)
    const store = new ProfileStore(file)
    expect(store.resolve('a')?.model).toBe('m-1')
    write([{ id: 'a', name: 'A', format: 'anthropic', model: 'm-2' }], 2)
    // watcher 防抖 300ms
    await new Promise((r) => setTimeout(r, 700))
    expect(store.resolve('a')?.model).toBe('m-2')
    store.close()
  })

  it('corrupt file keeps previous state', () => {
    write([{ id: 'a', name: 'A', format: 'anthropic', model: 'm-1' }])
    const store = new ProfileStore(file)
    writeFileSync(file, '{not json', 'utf8')
    expect(store.reload()).toBe(false)
    expect(store.resolve('a')?.model).toBe('m-1')
    store.close()
  })
})
