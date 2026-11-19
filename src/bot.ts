import type { TriggerMode } from './config.ts'
import { addDays, formatDayMonthTr, localDay, localTime, mondayOf } from './dates.ts'
import type { Store } from './db.ts'
import { buildDailyReport, escapeHtml, formatEntryReply, formatLeaderboard, kcal } from './format.ts'
import type { TelegramApi, TgMessage, TgUpdate, TgUser, VisionClient, VisionResult } from './types.ts'

export interface BotDeps {
  store: Store
  tg: TelegramApi
  vision: VisionClient
  botUsername: string
  allowedChatIds: Set<number>
  timezone: string
  triggerMode: TriggerMode
  model: string
  now?: () => Date
  log?: (message: string) => void
}

const HELP = [
  '<b>Kalori botu</b>',
  'Yemek fotoğrafını açıklamasına beni etiketleyerek at; kalorisini tahmin edip kaydederim.',
  'Açıklamaya yazdığın not tahmine katılır (ör. "yarım porsiyon", "2 dilim").',
  'Etiketi unuttuysan fotoğrafı yanıtlayıp beni etiketle. Aynı fotoğrafı yeni notla tekrar etiketlersen tahmin güncellenir.',
  '',
  '/rapor — bugünün dökümü',
  '/siralama — bu haftanın sıralaması (/siralama bugun, /siralama ay, /siralama hepsi)',
  '/sil — kendi kaydını sil (fotoğrafı ya da cevabımı yanıtlayarak)',
].join('\n')

/** `/name`, `/name@bot` and an optional argument tail. Commands addressed to another bot yield null. */
export function parseCommand(text: string, botUsername: string): { name: string; args: string } | null {
  const match = /^\/([a-z0-9_]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!match) return null
  const [, name = '', target, args = ''] = match
  if (target && target.toLowerCase() !== botUsername.toLowerCase()) return null
  return { name: name.toLowerCase(), args: args.trim() }
}

/**
 * Was this text addressed to the bot (an @mention anywhere, or a leading /kalori)? `note` is
 * what remains once the address is removed: the user's own words for the model.
 */
export function extractTrigger(text: string | undefined, botUsername: string): { triggered: boolean; note: string | null } {
  if (!text) return { triggered: false, note: null }
  const mention = new RegExp(`@${botUsername}(?![A-Za-z0-9_])`, 'gi')
  const command = new RegExp(`^\\s*/kalori(?:@${botUsername})?(?![A-Za-z0-9_@])`, 'i')
  const triggered = mention.test(text) || command.test(text)
  const note = text.replace(command, ' ').replace(mention, ' ').replace(/\s+/g, ' ').trim()
  return { triggered, note: note || null }
}

function displayName(user: TgUser): string {
  return user.last_name ? `${user.first_name} ${user.last_name}` : user.first_name
}

export async function handleUpdate(update: TgUpdate, deps: BotDeps): Promise<void> {
  const m = update.message
  if (!m?.from || m.from.is_bot) return
  const command = m.text ? parseCommand(m.text, deps.botUsername) : null

  // Works everywhere on purpose: it is how the owner learns a new group's id for the allowlist.
  if (command?.name === 'chatid') {
    await deps.tg.sendMessage(m.chat.id, `Chat ID: <code>${m.chat.id}</code>`, m.message_id)
    return
  }
  if (!deps.allowedChatIds.has(m.chat.id)) return

  if (command?.name === 'start' || command?.name === 'help' || command?.name === 'yardim') {
    await deps.tg.sendMessage(m.chat.id, HELP, m.message_id)
    return
  }
  if (command?.name === 'rapor') return sendTodayReport(m, deps)
  if (command?.name === 'siralama') return sendLeaderboard(m, command.args, deps)
  if (command?.name === 'sil') return deleteEntry(m, deps)

  if (m.photo) {
    const trigger = extractTrigger(m.caption, deps.botUsername)
    if (deps.triggerMode === 'all' || trigger.triggered) await analyse(m, trigger.note, deps)
    return
  }
  const target = m.reply_to_message
  if (target?.photo && m.text) {
    const trigger = extractTrigger(m.text, deps.botUsername)
    if (!trigger.triggered) return
    const original = extractTrigger(target.caption, deps.botUsername).note
    await analyse(target, [original, trigger.note].filter(Boolean).join(' · ') || null, deps)
  }
}

async function analyse(photoMessage: TgMessage, note: string | null, deps: BotDeps): Promise<void> {
  const owner = photoMessage.from
  // Telegram lists sizes ascending; the last is the largest (at most 1280 px on the long side).
  const photo = photoMessage.photo?.at(-1)
  if (!owner || owner.is_bot || !photo) return
  const chatId = photoMessage.chat.id

  await deps.tg.sendTyping(chatId).catch(() => {})
  let result: VisionResult
  try {
    const file = await deps.tg.downloadFile(photo.file_id)
    result = await deps.vision.estimate(file.bytes, file.mime, note)
  } catch (e) {
    deps.log?.(`analiz hatası chat=${chatId} msg=${photoMessage.message_id}: ${e instanceof Error ? e.message : 'bilinmeyen'}`)
    await deps.tg.sendMessage(chatId, 'Tahmin yapılamadı. Biraz sonra fotoğrafı yanıtlayıp beni tekrar etiketle.', photoMessage.message_id)
    return
  }
  if (!result.estimate.isFood) {
    await deps.tg.sendMessage(chatId, 'Fotoğrafta yiyecek göremedim; kayıt eklenmedi.', photoMessage.message_id)
    return
  }

  const postedAt = new Date(photoMessage.date * 1000)
  const day = localDay(postedAt, deps.timezone)
  const { id, replaced } = deps.store.upsertEntry({
    chatId,
    messageId: photoMessage.message_id,
    userId: owner.id,
    userName: displayName(owner),
    day,
    createdAt: postedAt.toISOString(),
    userNote: note,
    fileId: photo.file_id,
    estimate: result.estimate,
    model: deps.model,
    rawResponse: result.raw,
  })
  const entry = deps.store.findEntryByMessage(chatId, photoMessage.message_id)
  if (!entry) return
  const reply = formatEntryReply(entry, {
    replaced,
    dayTotalKcal: deps.store.dayTotalKcal(chatId, owner.id, day),
    isToday: day === localDay(deps.now?.() ?? new Date(), deps.timezone),
  })
  deps.store.setReplyMessageId(id, await deps.tg.sendMessage(chatId, reply, photoMessage.message_id))
}

async function sendTodayReport(m: TgMessage, deps: BotDeps): Promise<void> {
  const day = localDay(deps.now?.() ?? new Date(), deps.timezone)
  const entries = deps.store.entriesForDay(m.chat.id, day)
  if (entries.length === 0) {
    await deps.tg.sendMessage(m.chat.id, 'Bugün henüz kayıt yok.', m.message_id)
    return
  }
  for (const chunk of buildDailyReport(day, entries, deps.timezone)) await deps.tg.sendMessage(m.chat.id, chunk)
}

async function sendLeaderboard(m: TgMessage, arg: string, deps: BotDeps): Promise<void> {
  const today = localDay(deps.now?.() ?? new Date(), deps.timezone)
  const period = arg.toLocaleLowerCase('tr-TR')
  let from: string
  let title: string
  if (period === '' || period === 'hafta') {
    from = mondayOf(today)
    title = from === today ? 'bu hafta' : `bu hafta (${formatDayMonthTr(from)} – ${formatDayMonthTr(today)})`
  } else if (period === 'bugun' || period === 'bugün') {
    from = today
    title = `bugün (${formatDayMonthTr(today)})`
  } else if (period === 'ay') {
    from = `${today.slice(0, 8)}01`
    title = new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(
      new Date(`${today}T00:00:00Z`),
    )
  } else if (period === 'hepsi') {
    from = '0000-01-01'
    title = 'tüm zamanlar'
  } else {
    await deps.tg.sendMessage(m.chat.id, 'Kullanım: /siralama, /siralama bugun, /siralama ay, /siralama hepsi', m.message_id)
    return
  }
  const rows = deps.store.leaderboard(m.chat.id, from, today)
  await deps.tg.sendMessage(m.chat.id, rows.length === 0 ? 'Bu dönemde kayıt yok.' : formatLeaderboard(title, rows), m.message_id)
}

async function deleteEntry(m: TgMessage, deps: BotDeps): Promise<void> {
  const target = m.reply_to_message
  const entry = target ? deps.store.findEntryByMessage(m.chat.id, target.message_id) : undefined
  if (!entry) {
    await deps.tg.sendMessage(m.chat.id, 'Silmek için fotoğrafı ya da ona verdiğim cevabı yanıtlayarak /sil yaz.', m.message_id)
    return
  }
  if (entry.userId !== m.from?.id) {
    await deps.tg.sendMessage(m.chat.id, 'Bu kaydı yalnızca fotoğrafı atan kişi silebilir.', m.message_id)
    return
  }
  deps.store.deleteEntry(entry.id)
  await deps.tg.sendMessage(m.chat.id, `Silindi: ${escapeHtml(entry.dish)} (${kcal(entry.totalKcal)}).`, m.message_id)
}

/** How many past days a missed end-of-day report is still sent for. */
const REPORT_CATCH_UP_DAYS = 3

/**
 * Sends every due daily report: today's once the clock passes `reportTime`, and any earlier day
 * that was missed (machine asleep or off). A (chat, day) is marked only after its report went out.
 */
export async function sendDueReports(
  deps: Pick<BotDeps, 'store' | 'tg' | 'allowedChatIds' | 'timezone' | 'log'>,
  reportTime: string,
  now: Date,
): Promise<void> {
  const today = localDay(now, deps.timezone)
  const due = localTime(now, deps.timezone) >= reportTime
  for (const { chatId, day } of deps.store.pendingReports(today, due, addDays(today, -REPORT_CATCH_UP_DAYS))) {
    if (!deps.allowedChatIds.has(chatId)) continue
    for (const chunk of buildDailyReport(day, deps.store.entriesForDay(chatId, day), deps.timezone)) {
      await deps.tg.sendMessage(chatId, chunk)
    }
    deps.store.markReportSent(chatId, day, now.toISOString())
    deps.log?.(`rapor gönderildi chat=${chatId} gün=${day}`)
  }
}
