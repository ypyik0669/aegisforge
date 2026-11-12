/**
 * dsh-workflow-lite — 配置面（flowd 适配版）。
 *
 * 上游用 schemastery + cordis 活引用。flowd 没有设置表单引擎，改成普通默认值对象：
 * 活配置引用由 `adapters/settings.ts` 提供，读写 `dataDir/settings.json`；
 * 本文件只留默认值、键名与类型，避免装配层和设置页各写一遍。
 *
 * 部署相关的取值：`dataDir`（数据根）、`maxNodes`、`maxResultBytes`
 * （单次返回字节上限）、`saveDebounceMs`、`installSkill`。
 *
 * @module @xiaoso/dsh-workflow-lite/host/config
 */

import { join } from 'node:path'
import type { Volatile } from '../compat/cordis.ts'

/** 设置命名空间（也是 SETTINGS 行/页面的 id）。 */
export const WORKFLOW_LITE_SETTINGS_NS = 'workflow-lite'

/** 插件在 profile 里的那一行的 id（保留给设置页寻找自己那一行）。 */
export const WORKFLOW_LITE_ROW_ID = 'workflow-lite'

/** 解析后的活配置。 */
export interface WorkflowLiteSettings {
  /** 数据根目录。`workflows/`、`templates/` 与 `.dispatch/` 都在它下面。 */
  dataDir: Volatile<string>
  /** 画布改动落盘的防抖毫秒数。**拖动过程中不写盘，指针停稳后才写一次。** */
  saveDebounceMs: Volatile<number>
  /** 单图节点数上限。超出：落盘允许、自动布局不跑、**编译挡住**。 */
  maxNodes: Volatile<number>
  /** 单次工具 / RPC 返回的字节上限。超限**报错而不截断**。 */
  maxResultBytes: Volatile<number>
  /** 是否随插件注册按需 skill（设计图、运行状态、看板）。 */
  installSkill: Volatile<boolean>
}

/** 一组普通（非活引用）配置值。 */
export interface WorkflowLiteValues {
  dataDir: string
  saveDebounceMs: number
  maxNodes: number
  maxResultBytes: number
  installSkill: boolean
}

/** flowd 默认数据根：`AF_DATA_DIR` 优先，否则 `<cwd>/data`。 */
export const DEFAULT_DATA_DIR: string = process.env.AF_DATA_DIR ?? join(process.cwd(), 'data')

/**
 * 运行期默认值。上游把这些写在 schema 里；flowd 写在普通对象里，
 * `adapters/settings.ts` 以它作为「恢复默认」的基线。
 */
export const Config: WorkflowLiteValues = {
  dataDir: DEFAULT_DATA_DIR,
  saveDebounceMs: 400,
  maxNodes: 400,
  maxResultBytes: 262_144,
  installSkill: true,
}

/** 五个键的名字（测试与文档用，避免两处各写一遍）。 */
export const CONFIG_KEYS = [
  'dataDir',
  'saveDebounceMs',
  'maxNodes',
  'maxResultBytes',
  'installSkill',
] as const
