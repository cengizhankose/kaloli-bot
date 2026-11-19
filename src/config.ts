export type TriggerMode = 'mention' | 'all'

export interface Config {
  telegramToken: string
  proxyBaseUrl: string
  proxyApiKey: string
  visionModel: string
  /** Chats the bot works in. Empty = it analyses nothing (fail closed). */
  allowedChatIds: Set<number>
  timezone: string
  /** Local "HH:MM" at which the daily report goes out. */
  reportTime: string
  /** `mention`: only photos that tag the bot. `all`: every photo in an allowed chat. */
  triggerMode: TriggerMode
  dbPath: string
}

type Env = Record<string, string | undefined>

function required(env: Env, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new Error(`${key} tanımlı değil (.env)`)
  return value
}

export function loadConfig(env: Env): Config {
  const reportTime = env.REPORT_TIME?.trim() || '23:55'
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(reportTime)) throw new Error('REPORT_TIME "SS:DD" biçiminde olmalı')

  const triggerMode = env.TRIGGER_MODE?.trim() || 'mention'
  if (triggerMode !== 'mention' && triggerMode !== 'all') throw new Error('TRIGGER_MODE "mention" veya "all" olmalı')

  const timezone = env.TIMEZONE?.trim() || 'Europe/Istanbul'
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone }) // throws on an unknown zone

  const allowedChatIds = new Set<number>()
  for (const part of (env.ALLOWED_CHAT_IDS ?? '').split(',')) {
    const raw = part.trim()
    if (!raw) continue
    const id = Number(raw)
    if (!Number.isSafeInteger(id)) throw new Error('ALLOWED_CHAT_IDS virgülle ayrılmış sayılar olmalı')
    allowedChatIds.add(id)
  }

  return {
    telegramToken: required(env, 'TELEGRAM_BOT_TOKEN'),
    proxyBaseUrl: (env.PROXY_BASE_URL?.trim() || 'http://127.0.0.1:8317').replace(/\/+$/, ''),
    proxyApiKey: required(env, 'PROXY_API_KEY'),
    visionModel: env.VISION_MODEL?.trim() || 'gemini-3.5-flash-lite',
    allowedChatIds,
    timezone,
    reportTime,
    triggerMode,
    dbPath: env.DB_PATH?.trim() || 'data/kalori.db',
  }
}
