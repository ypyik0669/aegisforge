/**
 * flowd 的 skill 存储：内置 skill 的注册表 + `dataDir/skills/` 的文件扫描。
 *
 * - `register`：`ctx.skills` 的内置 / 运行时 skill（workflow-authoring 等），只存内存。
 * - `list` / `get`：`hostFs.ts` 的 SkillLister 形状，供画布的「选 Skill / 预览」
 *   与导出包使用。文件 skill 从 `<dataDir>/skills/<目录>/SKILL.md` 读取，
 *   YAML frontmatter 取 name / description / whenToUse，正文就是 content。
 *
 * 作用域（DSH 的 agent 预设）在 flowd 里不存在，参数被忽略。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'
import type { SkillRegistration, SkillsService } from '../compat/cordis.ts'

/** 一条 skill 的摘要（与 `hostFs.ts` 的 SkillSummaryLike 同构）。 */
export interface SkillSummary {
  name: string
  description: string
  source: string
  path?: string
  whenToUse?: string
  metadata?: Readonly<Record<string, unknown>>
  invocation: { modelInvocable: boolean }
}

/** 一条 skill 的全文。 */
export interface SkillFull extends SkillSummary {
  content: string
}

/** skill 查询的作用域（flowd 不区分作用域，保留形状）。 */
export interface SkillLookup {
  cwd?: string
  scope?: object
}

/** `dataDir/skills/` 下的一个文件 skill。 */
interface FileSkill extends SkillFull {
  dir: string
}

/** 注册表 + 文件扫描。 */
export class SkillsStore implements SkillsService {
  private readonly registered = new Map<string, SkillRegistration & { source: string }>()
  private readonly dir: string

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'skills')
  }

  register(spec: SkillRegistration): () => void {
    const entry: SkillRegistration & { source: string } = {
      ...spec,
      source: spec.source ?? 'runtime',
    }
    this.registered.set(spec.name, entry)
    return () => {
      if (this.registered.get(spec.name) === entry) this.registered.delete(spec.name)
    }
  }

  async list(_options?: SkillLookup): Promise<readonly SkillSummary[]> {
    const files = await this.scan()
    const names = new Set(files.map((skill) => skill.name))
    const builtIns = [...this.registered.values()]
      .filter((skill) => !names.has(skill.name))
      .map((skill) => this.summaryOf(skill))
    return [...files.map((skill) => this.summaryOf(skill)), ...builtIns]
  }

  async get(name: string, _options?: SkillLookup): Promise<SkillFull | undefined> {
    const files = await this.scan()
    const file = files.find((skill) => skill.name === name)
    if (file !== undefined) return this.fullOf(file)
    const builtIn = this.registered.get(name)
    if (builtIn !== undefined) return { ...this.summaryOf(builtIn), content: builtIn.content }
    return undefined
  }

  private summaryOf(skill: {
    name: string
    description: string
    source: string
    path?: string
    whenToUse?: string
    metadata?: Readonly<Record<string, unknown>>
    invocation?: { modelInvocable: boolean }
  }): SkillSummary {
    return {
      name: skill.name,
      description: skill.description,
      source: skill.source,
      ...(skill.path === undefined ? {} : { path: skill.path }),
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      ...(skill.metadata === undefined ? {} : { metadata: skill.metadata }),
      invocation: skill.invocation ?? { modelInvocable: true },
    }
  }

  private fullOf(skill: FileSkill): SkillFull {
    return { ...this.summaryOf(skill), content: skill.content }
  }

  /** 扫每个 skill 目录下的 SKILL.md；目录不存在或单个文件坏掉都只跳过。 */
  private async scan(): Promise<FileSkill[]> {
    let names: string[]
    try {
      names = (await readdir(this.dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
    const skills = await Promise.all(
      names.map(async (dir): Promise<FileSkill | undefined> => {
        const path = resolve(this.dir, dir, 'SKILL.md')
        let raw: string
        try {
          raw = await readFile(path, 'utf8')
        } catch {
          return undefined
        }
        const parsed = parseSkillFile(raw, dir)
        if (parsed === undefined) return undefined
        return {
          name: parsed.name,
          description: parsed.description,
          source: 'filesystem',
          path,
          ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
          ...(Object.keys(parsed.metadata).length === 0 ? {} : { metadata: parsed.metadata }),
          invocation: { modelInvocable: true },
          content: parsed.content,
          dir,
        }
      }),
    )
    return skills.filter((skill): skill is FileSkill => skill !== undefined)
  }
}

/** 造一个 skill 存储。 */
export function createSkillsStore(dataDir: string): SkillsStore {
  return new SkillsStore(dataDir)
}

/** 解析 SKILL.md：YAML frontmatter + 正文。 */
function parseSkillFile(
  raw: string,
  fallbackName: string,
):
  | {
      name: string
      description: string
      whenToUse?: string
      metadata: Record<string, unknown>
      content: string
    }
  | undefined {
  const text = raw.replace(/^\uFEFF/u, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(text)
  const body = (match === null ? text : text.slice(match[0].length)).trim()
  let meta: Record<string, unknown> = {}
  if (match !== null) {
    try {
      const parsed = parse(match[1]) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>
      }
    } catch {
      return undefined
    }
  }
  const name = stringField(meta, 'name') ?? fallbackName
  const description = stringField(meta, 'description') ?? ''
  const whenToUse =
    stringField(meta, 'whenToUse') ??
    stringField(meta, 'when_to_use') ??
    stringField(meta, 'when-to-use')
  const metadata: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(meta)) {
    if (key === 'name' || key === 'description' || key === 'whenToUse') continue
    if (key === 'when_to_use' || key === 'when-to-use') continue
    metadata[key] = value
  }
  return {
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    metadata,
    content: body,
  }
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}
