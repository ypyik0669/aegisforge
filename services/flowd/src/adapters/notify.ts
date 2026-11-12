/**
 * run 终态通知：钉钉 / 飞书 / Telegram / 通用 webhook。
 *
 * 配置全走环境变量（有多条就都发，互不影响，单条失败只记日志）：
 * - `AF_NOTIFY_DINGTALK`：钉钉机器人 webhook（含 access_token）；
 * - `AF_NOTIFY_FEISHU`：飞书自定义机器人 webhook；
 * - `AF_NOTIFY_TELEGRAM`：Telegram bot token（消息发给 AF_NOTIFY_TG_CHAT_ID）；
 * - `AF_NOTIFY_WEBHOOK`：通用接收端，POST `{ text, run }`。
 *
 * 文案默认中文；run 信息截断防刷屏。SMTP 邮件通道留在 Go 侧（RuoJi6 上游
 * 本来就在 Go），flowd 只做 webhook 类。
 */

import type { RunInfo } from './runner.ts'

export interface NotifyChannels {
  dingtalk?: string
  feishu?: string
  telegram?: string
  telegramChatId?: string
  generic?: string
}

/** 从环境读通知配置。 */
export function readNotifyChannels(env: NodeJS.ProcessEnv = process.env): NotifyChannels {
  const pick = (name: string) => {
    const value = env[name]
    return value !== undefined && value !== '' ? value : undefined
  }
  return {
    ...(pick('AF_NOTIFY_DINGTALK') === undefined ? {} : { dingtalk: pick('AF_NOTIFY_DINGTALK') }),
    ...(pick('AF_NOTIFY_FEISHU') === undefined ? {} : { feishu: pick('AF_NOTIFY_FEISHU') }),
    ...(pick('AF_NOTIFY_TELEGRAM') === undefined ? {} : { telegram: pick('AF_NOTIFY_TELEGRAM') }),
    ...(pick('AF_NOTIFY_TG_CHAT_ID') === undefined ? {} : { telegramChatId: pick('AF_NOTIFY_TG_CHAT_ID') }),
    ...(pick('AF_NOTIFY_WEBHOOK') === undefined ? {} : { generic: pick('AF_NOTIFY_WEBHOOK') }),
  }
}

const PROMPT_PREVIEW_CHARS = 120

/** run 终态的中文文案。 */
export function formatRunNotice(info: RunInfo): string {
  const statusText: Record<string, string> = {
    done: '完成',
    failed: '失败',
    stopped: '中止',
  }
  const status = statusText[info.status] ?? info.status
  const error = info.error !== undefined ? `\n错误：${info.error.slice(0, 300)}` : ''
  return `flowd 运行${status}\nrun=${info.id}\n状态=${status} 轮次=${info.turns}\n任务=${info.prompt.slice(0, PROMPT_PREVIEW_CHARS)}${error}`
}

async function post(url: string, body: unknown, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}: ${(await response.text()).slice(0, 200)}`)
  }
}

/** 各渠道的 payload 形状（钉钉 text 消息 / 飞书 text / Telegram sendMessage）。 */
export async function sendRunNotice(
  channels: NotifyChannels,
  info: RunInfo,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const text = formatRunNotice(info)
  const results: string[] = []
  if (channels.dingtalk !== undefined) {
    results.push(
      'dingtalk',
      await trySend(() => post(channels.dingtalk as string, { msgtype: 'text', text: { content: text } }, fetchImpl)),
    )
  }
  if (channels.feishu !== undefined) {
    results.push(
      'feishu',
      await trySend(() => post(channels.feishu as string, { msg_type: 'text', content: { text } }, fetchImpl)),
    )
  }
  if (channels.telegram !== undefined && channels.telegramChatId !== undefined) {
    results.push(
      'telegram',
      await trySend(() =>
        post(
          `https://api.telegram.org/bot${channels.telegram as string}/sendMessage`,
          { chat_id: channels.telegramChatId, text },
          fetchImpl,
        ),
      ),
    )
  }
  if (channels.generic !== undefined) {
    results.push(
      'webhook',
      await trySend(() => post(channels.generic as string, { text, run: { id: info.id, status: info.status } }, fetchImpl)),
    )
  }
  return results
}

async function trySend(send: () => Promise<void>): Promise<'ok' | string> {
  try {
    await send()
    return 'ok'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
