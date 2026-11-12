/**
 * LLM profiles：文件态的 `llm_profiles`（与 db/schema.sql 里 PG 表同字段子集）。
 *
 * 单表双端消费的设计点不变：Go 侧读 PG 的 llm_profiles，flowd 在没有 PG 的
 * 部署（standalone）读 `dataDir/llm_profiles.json`，两边语义一致——按
 * `is_default` / 显式 id 选一条，换 model + ANTHROPIC_BASE_URL +
 * ANTHROPIC_API_KEY 注入 SDK 会话。
 *
 * 热加载：fs.watch 监听文件变化，改完保存即生效（下一个 spawnRun 起新配置），
 * 不用重启 flowd。
 *
 * base_url 的语义：**必须说 Anthropic Messages API**。DeepSeek / GLM / Moonshot
 * 都提供 anthropic 兼容端点（如 https://api.deepseek.com/anthropic）；纯
 * openai 兼容端点（如 Ollama /v1）不带 /messages 协议，SDK 打不通——这类
 * provider 需要挂一层协议转换网关再把地址填进来。
 *
 * 凭据：文件里允许 `api_key`（本地自用）或 `api_key_env`（推荐，指向环境变量名），
 * resolve 时 API key 永不出现在 list() 的回执里。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'

export type LlmProfileFormat = 'anthropic' | 'openai' | 'openai-responses' | 'ollama'

/** llm_profiles.json 里的一条（PG llm_profiles 表的文件态子集）。 */
export interface LlmProfile {
  id: string
  name: string
  format: LlmProfileFormat
  /** 必须说 Anthropic Messages API（见模块注释）。 */
  baseUrl?: string
  model?: string
  apiKey?: string
  /** 推荐：从环境变量取 key，文件里只存变量名。 */
  apiKeyEnv?: string
  isDefault?: boolean
  enabled?: boolean
}

/** llm_profiles.json 的落盘形状。 */
export interface ProfileFile {
  revision: number
  profiles: LlmProfile[]
}

/** resolve 的产物：直接喂给 runner 的逐 run 覆盖。 */
export interface ResolvedProfile {
  id: string
  name: string
  format: LlmProfileFormat
  model?: string
  baseUrl?: string
  apiKey?: string
}

/** list() 给出去的一条（凭据打码）。 */
export interface ProfileSummary {
  id: string
  name: string
  format: LlmProfileFormat
  model?: string
  baseUrl?: string
  isDefault: boolean
  enabled: boolean
  /** key 来源：env 变量名 / 'file' / 缺失。 */
  apiKeySource: string
}

export class ProfileStore {
  readonly file: string
  revision = 0
  private profiles: LlmProfile[] = []
  private watcher: FSWatcher | undefined
  private readonly log: (line: string) => void

  constructor(filePath: string, log: (line: string) => void = () => {}) {
    this.file = filePath
    this.log = log
    this.reload()
    this.watchFile()
  }

  /** 读盘 + 容错（坏文件保持旧状态）。 */
  reload(): boolean {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return false
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
      const record = parsed as Record<string, unknown>
      const list = record.profiles
      if (!Array.isArray(list)) return false
      const next: LlmProfile[] = []
      for (const item of list) {
        const profile = sanitizeProfile(item)
        if (profile !== null) next.push(profile)
      }
      if (typeof record.revision === 'number' && Number.isInteger(record.revision)) {
        this.revision = record.revision
      }
      this.profiles = next
      this.log(`[flowd] llm_profiles 已加载 ${next.length} 条（revision ${this.revision}）`)
      return true
    } catch (error) {
      this.log(`[flowd] llm_profiles 解析失败，保持旧状态：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  private watchFile(): void {
    try {
      this.watcher = watch(dirname(this.file), (_event, filename) => {
        if (filename !== null && filename !== '' && filename !== 'llm_profiles.json') return
        // 编辑器原子替换：事件可能早于内容落盘，下一轮 tick 再读。
        setTimeout(() => {
          this.reload()
        }, 300)
      })
      this.watcher.on('error', () => {
        // 目录没了/不可读：静默，下次 resolve 前可手动 reload。
      })
      this.watcher.unref?.()
    } catch {
      // 文件还不存在时 watch 目录失败也无所谓；保存第一版后可重启再挂。
    }
  }

  /** 给 UI 的目录（key 永不出现）。 */
  list(): ProfileSummary[] {
    return this.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      format: profile.format,
      ...(profile.model === undefined ? {} : { model: profile.model }),
      ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }),
      isDefault: profile.isDefault === true,
      enabled: profile.enabled !== false,
      apiKeySource:
        profile.apiKeyEnv !== undefined && process.env[profile.apiKeyEnv] !== undefined
          ? profile.apiKeyEnv
          : profile.apiKey !== undefined
            ? 'file'
            : '(missing)',
    }))
  }

  /**
   * 选一条 profile：显式 id → 唯一 isDefault → undefined（回落到 runner 环境
   * 配置）。disabled 的条目跳过。
   */
  resolve(profileId?: string): ResolvedProfile | undefined {
    if (profileId === undefined) {
      const defaults = this.profiles.filter((profile) => profile.isDefault === true && profile.enabled !== false)
      if (defaults.length !== 1) return undefined
      return this.materialize(defaults[0])
    }
    const found = this.profiles.find(
      (profile) => profile.id === profileId && profile.enabled !== false,
    )
    if (found === undefined) return undefined
    return this.materialize(found)
  }

  private materialize(profile: LlmProfile): ResolvedProfile {
    let apiKey: string | undefined
    if (profile.apiKeyEnv !== undefined && process.env[profile.apiKeyEnv] !== undefined) {
      apiKey = process.env[profile.apiKeyEnv]
    } else if (profile.apiKey !== undefined && profile.apiKey !== '') {
      apiKey = profile.apiKey
    }
    return {
      id: profile.id,
      name: profile.name,
      format: profile.format,
      ...(profile.model === undefined ? {} : { model: profile.model }),
      ...(profile.baseUrl === undefined ? {} : { baseUrl: profile.baseUrl }),
      ...(apiKey === undefined ? {} : { apiKey }),
    }
  }

  /** 写回文件（原子替换）并立刻重载；给测试和未来的 UI 编辑用。 */
  save(file: ProfileFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
    renameSync(temp, this.file)
    this.reload()
  }

  close(): void {
    this.watcher?.close()
  }
}

function sanitizeProfile(item: unknown): LlmProfile | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
  const record = item as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const format = record.format
  if (id === '' || name === '') return null
  if (format !== 'anthropic' && format !== 'openai' && format !== 'openai-responses' && format !== 'ollama') {
    return null
  }
  const out: LlmProfile = { id, name, format }
  for (const key of ['baseUrl', 'model', 'apiKey', 'apiKeyEnv'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim()
  }
  if (record.isDefault === true) out.isDefault = true
  if (record.enabled === false) out.enabled = false
  return out
}

/** 默认路径：dataDir/llm_profiles.json。 */
export function profilesFilePath(dataDir: string): string {
  return join(dataDir, 'llm_profiles.json')
}

/** 存在性探测（doctor 用）。 */
export function profilesFileExists(dataDir: string): boolean {
  return existsSync(profilesFilePath(dataDir))
}

/** 造一个 profile store。 */
export function createProfileStore(
  filePath: string,
  log?: (line: string) => void,
): ProfileStore {
  return new ProfileStore(filePath, log)
}
