/**
 * flowd 的设置适配层：`SettingsPort` 的 JSON 文件实现。
 *
 * - 设置存在 `<启动数据根>/settings.json`，形状 `{ revision, values }`。
 * - `describe` / `mutate` 满足 `host/pluginConfig.ts` 的 SettingsPort：
 *   写入带修订号，别人先改过时抛 `SETTINGS_CONFLICT`。
 * - 同一份值同步投影成 `WorkflowLiteSettings` 的五个活引用，装配层和
 *   `config/get` 读的是同一份内存状态。
 *
 * TODO(flowd)：设置服务只改了运行中的活引用；`dataDir` / `installSkill`
 * 的上游语义是「重启才生效」，这里也不做热迁移。
 */

import { mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  Config,
  WORKFLOW_LITE_ROW_ID,
  type WorkflowLiteSettings,
  type WorkflowLiteValues,
} from '../host/config.ts'
import type { SettingsPort, SettingsRow } from '../host/pluginConfig.ts'
import { volatile, type MutableVolatile } from '../compat/cordis.ts'
import { PLUGIN_CONFIG_KEYS, type PluginConfigKey } from '../shared/wire.ts'

/** settings.json 的落盘形状：只存用户改过的项（默认值仍由 Config 提供）。 */
interface StoredSettings {
  revision: number
  values: Partial<WorkflowLiteValues>
}

/** 设置页 / RPC 看到的那一行使用的 ns。 */
const SETTINGS_NS = WORKFLOW_LITE_ROW_ID

/** 一份 JSON 设置文件的读写器 + SettingsPort + 活引用。 */
export class SettingsAdapter implements SettingsPort {
  readonly writable = true
  readonly live: WorkflowLiteSettings

  private readonly file: string
  private readonly defaults: WorkflowLiteValues
  private revision = 0
  private overrides: Partial<WorkflowLiteValues> = {}
  private watcher: FSWatcher | undefined
  private readonly refs: {
    dataDir: MutableVolatile<string>
    saveDebounceMs: MutableVolatile<number>
    maxNodes: MutableVolatile<number>
    maxResultBytes: MutableVolatile<number>
    installSkill: MutableVolatile<boolean>
  }

  constructor(dataRoot: string) {
    this.file = join(dataRoot, 'settings.json')
    this.defaults = { ...Config, dataDir: dataRoot }
    this.refs = {
      dataDir: volatile(this.defaults.dataDir),
      saveDebounceMs: volatile(this.defaults.saveDebounceMs),
      maxNodes: volatile(this.defaults.maxNodes),
      maxResultBytes: volatile(this.defaults.maxResultBytes),
      installSkill: volatile(this.defaults.installSkill),
    }
    this.live = this.refs
    this.load()
    this.project()
    this.watchFile()
  }

  /** 文件外部改动热监听：revision 比内存新才采纳（自己的 persist 回声会跳过）。 */
  private watchFile(): void {
    try {
      this.watcher = watch(dirname(this.file), (_event, filename) => {
        if (filename !== null && filename !== '' && filename !== 'settings.json') return
        setTimeout(() => {
          if (this.load()) this.project()
        }, 300)
      })
      this.watcher.on('error', () => {})
      this.watcher.unref?.()
    } catch {
      // 目录不可 watch（首次写盘前不存在等）：不影响启动。
    }
  }

  /** 当前合并后的值（默认值 + 用户改动）。 */
  values(): WorkflowLiteValues {
    return { ...this.defaults, ...this.overrides }
  }

  describe(_options?: { redactSecrets?: boolean }): readonly SettingsRow[] {
    return [
      {
        ns: SETTINGS_NS,
        revision: this.revision,
        value: this.values(),
        base: { ...this.defaults },
        user: { ...this.overrides },
      },
    ]
  }

  async mutate(
    ns: string,
    ops: readonly (
      | { op: 'set'; path: readonly string[]; value: unknown }
      | { op: 'unset'; path: readonly string[] }
    )[],
    expectedRevision?: number,
  ): Promise<void> {
    if (ns !== SETTINGS_NS) {
      throw settingsError('unavailable', `不认识的设置命名空间 ${ns}`)
    }
    if (expectedRevision !== undefined && expectedRevision !== this.revision) {
      throw settingsError('SETTINGS_CONFLICT', '设置已被其他写入更新')
    }
    const next: Partial<WorkflowLiteValues> = { ...this.overrides }
    for (const op of ops) {
      const key = op.path[0]
      if (key === undefined || !isConfigKey(key)) {
        throw settingsError('invalid_args', `不认识的设置项 ${String(key)}`)
      }
      if (op.op === 'unset') {
        delete next[key]
        continue
      }
      if (!accepts(key, op.value)) {
        throw settingsError('invalid_args', `设置项 ${key} 的值不合法`)
      }
      ;(next as Record<string, unknown>)[key] = op.value
    }
    this.overrides = next
    this.revision += 1
    this.project()
    await this.persist()
  }

  /** 把当前值写进活引用。 */
  private project(): void {
    const values = this.values()
    this.refs.dataDir.set(values.dataDir)
    this.refs.saveDebounceMs.set(values.saveDebounceMs)
    this.refs.maxNodes.set(values.maxNodes)
    this.refs.maxResultBytes.set(values.maxResultBytes)
    this.refs.installSkill.set(values.installSkill)
  }

  /** 读盘；返回是否有比内存新的修订（热监听据此决定是否重投影）。 */
  private load(): boolean {
    let raw: string
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch {
      return false
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      if (typeof parsed !== 'object' || parsed === null) return false
      const record = parsed as Record<string, unknown>
      const fileRevision =
        typeof record.revision === 'number' && Number.isInteger(record.revision)
          ? Math.max(0, record.revision)
          : 0
      const values = record.values
      const overrides: Partial<WorkflowLiteValues> = {}
      if (typeof values === 'object' && values !== null && !Array.isArray(values)) {
        for (const key of PLUGIN_CONFIG_KEYS) {
          const value = (values as Record<string, unknown>)[key]
          if (accepts(key, value)) {
            ;(overrides as Record<string, unknown>)[key] = value
          }
        }
      }
      if (fileRevision < this.revision) return false
      const changed = fileRevision !== this.revision
      this.revision = fileRevision
      this.overrides = overrides
      return changed
    } catch {
      // 坏文件按空设置启动；下次写入会覆盖它。
      return false
    }
  }

  private async persist(): Promise<void> {
    const payload: StoredSettings = { revision: this.revision, values: this.overrides }
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(temp, this.file)
  }

  /** 停掉文件监听（测试/关停用）。 */
  close(): void {
    this.watcher?.close()
  }
}

/** 造一个设置适配器。 */
export function createSettings(dataRoot: string): SettingsAdapter {
  return new SettingsAdapter(dataRoot)
}

function isConfigKey(value: string): value is PluginConfigKey {
  return (PLUGIN_CONFIG_KEYS as readonly string[]).includes(value)
}

function accepts(key: PluginConfigKey, value: unknown): boolean {
  switch (key) {
    case 'dataDir':
      return typeof value === 'string' && value.trim() !== ''
    case 'installSkill':
      return typeof value === 'boolean'
    case 'maxNodes':
      return isInt(value, 1)
    case 'saveDebounceMs':
      return isInt(value, 0)
    case 'maxResultBytes':
      return isInt(value, 1024)
  }
}

function isInt(value: unknown, min: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min
}

/** 带 code 的错误：pluginConfig 靠 `error.code === 'SETTINGS_CONFLICT'` 识别冲突。 */
function settingsError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code?: string }
  error.code = code
  return error
}
