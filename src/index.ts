import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { handleUpdate, sendDueReports, type BotDeps } from './bot.ts'
import { loadConfig } from './config.ts'
import { Store } from './db.ts'
import { Telegram, TelegramError } from './telegram.ts'
import { createVisionClient } from './vision.ts'

const OFFSET_KEY = 'telegram_offset'
const POLL_TIMEOUT_SEC = 50
const REPORT_CHECK_MS = 30_000

function log(message: string): void {
  console.log(`${new Date().toISOString()} ${message}`)
}

const config = loadConfig(process.env)
mkdirSync(dirname(config.dbPath), { recursive: true })
const store = new Store(config.dbPath)
const tg = new Telegram(config.telegramToken)
const me = await tg.getMe()
if (!me.username) throw new Error('botun kullanıcı adı yok')

const deps: BotDeps = {
  store,
  tg,
  vision: createVisionClient({ baseUrl: config.proxyBaseUrl, apiKey: config.proxyApiKey, model: config.visionModel }),
  botUsername: me.username,
  allowedChatIds: config.allowedChatIds,
  timezone: config.timezone,
  triggerMode: config.triggerMode,
  model: config.visionModel,
  log,
}

log(
  `başladı @${me.username} model=${config.visionModel} tetik=${config.triggerMode} rapor=${config.reportTime} ` +
    `izinli_chat=${config.allowedChatIds.size}`,
)
if (config.allowedChatIds.size === 0) log('UYARI: ALLOWED_CHAT_IDS boş; grupta /chatid yazıp .env dosyasına ekle')

let reporting = false
setInterval(async () => {
  if (reporting) return
  reporting = true
  try {
    await sendDueReports(deps, config.reportTime, new Date())
  } catch (e) {
    log(`rapor hatası: ${e instanceof Error ? e.message : 'bilinmeyen'}`)
  } finally {
    reporting = false
  }
}, REPORT_CHECK_MS)

const savedOffset = store.getMeta(OFFSET_KEY)
let offset = savedOffset === undefined ? undefined : Number(savedOffset)
for (;;) {
  let updates
  try {
    updates = await tg.getUpdates(offset, POLL_TIMEOUT_SEC)
  } catch (e) {
    const conflict = e instanceof TelegramError && e.code === 409
    log(conflict ? 'başka bir kopya aynı tokenla çalışıyor (409)' : `getUpdates hatası: ${e instanceof Error ? e.message : 'bilinmeyen'}`)
    await Bun.sleep(conflict ? 30_000 : 5_000)
    continue
  }
  for (const update of updates) {
    try {
      await handleUpdate(update, deps)
    } catch (e) {
      log(`update ${update.update_id} işlenemedi: ${e instanceof Error ? e.message : 'bilinmeyen'}`)
    }
    // Persisted per update so a restart neither replays an answered photo nor skips an unseen one.
    offset = update.update_id + 1
    store.setMeta(OFFSET_KEY, String(offset))
  }
}
