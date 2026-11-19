import type { Entry, LeaderboardRow } from './db.ts'
import { formatDayTr, localTime } from './dates.ts'
import type { FoodItem } from './types.ts'

/** Telegram rejects messages over 4096 characters; stay under it with room for entities. */
export const MAX_MESSAGE = 4000

const number = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 })

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function kcal(n: number): string {
  return `${number.format(n)} kcal`
}

const pieces = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 })

/** "Yumurta, 2 adet · 100 g — 155 kcal" when counted; "Tavuk göğsü 120 g — 198 kcal" otherwise. */
function itemLine(item: FoodItem): string {
  const name = escapeHtml(item.name)
  const grams = item.grams === null ? null : `${number.format(item.grams)} g`
  const label =
    item.count === null
      ? [name, grams].filter(Boolean).join(' ')
      : `${name}, ${[`${pieces.format(item.count)} adet`, grams].filter(Boolean).join(' · ')}`
  return `  • ${label} — ${kcal(item.kcal)}`
}

interface Macros {
  proteinG: number | null
  carbsG: number | null
  fatG: number | null
}

function macroLine(m: Macros): string | null {
  if (m.proteinG === null || m.carbsG === null || m.fatG === null) return null
  return `P ${number.format(m.proteinG)} g · K ${number.format(m.carbsG)} g · Y ${number.format(m.fatG)} g`
}

/** The bot's answer under an analysed photo. */
export function formatEntryReply(
  entry: Entry,
  opts: { replaced: boolean; dayTotalKcal: number; isToday: boolean },
): string {
  const lines = [`<b>${escapeHtml(entry.dish)} · ~${kcal(entry.totalKcal)}</b>`, ...entry.items.map(itemLine)]
  const macros = macroLine(entry)
  if (macros) lines.push(macros)
  if (entry.confidence) lines.push(`Güven: ${entry.confidence}`)
  if (entry.modelNote) lines.push(`Varsayım: ${escapeHtml(entry.modelNote)}`)
  const when = opts.isToday ? 'bugün' : formatDayTr(entry.day)
  lines.push(`${escapeHtml(entry.userName)} · ${when} toplam ${kcal(opts.dayTotalKcal)}`)
  if (opts.replaced) lines.push('Önceki tahmin güncellendi.')
  return lines.join('\n')
}

/** Joins whole lines into as few messages as fit; a line is never cut, so HTML tags stay intact. */
export function splitLines(lines: string[], max = MAX_MESSAGE): string[] {
  const chunks: string[] = []
  let current = ''
  for (const line of lines) {
    if (current && current.length + 1 + line.length > max) {
      chunks.push(current)
      current = line
    } else {
      current = current ? `${current}\n${line}` : line
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function sumMacro(entries: Entry[], pick: (e: Entry) => number | null): number | null {
  let total = 0
  for (const e of entries) {
    const value = pick(e)
    if (value === null) return null
    total += value
  }
  return total
}

/**
 * The end-of-day breakdown for one chat: per person the day's total, then every meal with its
 * time and items. People are listed alphabetically. Returns ready-to-send messages.
 */
export function buildDailyReport(day: string, entries: Entry[], timeZone: string): string[] {
  const byUser = new Map<number, Entry[]>()
  for (const entry of entries) {
    const list = byUser.get(entry.userId) ?? []
    list.push(entry)
    byUser.set(entry.userId, list)
  }
  // A person's display name can change during the day; the latest one wins.
  const people = [...byUser.values()]
    .map((list) => ({ name: list[list.length - 1]!.userName, list }))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr-TR'))

  const lines = [`<b>Günlük rapor · ${formatDayTr(day)}</b>`]
  for (const { name, list } of people) {
    const total = list.reduce((sum, e) => sum + e.totalKcal, 0)
    lines.push('', `<b>${escapeHtml(name)} — ${kcal(total)}</b> (${list.length} kayıt)`)
    const macros = macroLine({
      proteinG: sumMacro(list, (e) => e.proteinG),
      carbsG: sumMacro(list, (e) => e.carbsG),
      fatG: sumMacro(list, (e) => e.fatG),
    })
    if (macros) lines.push(macros)
    for (const entry of list) {
      lines.push(`${localTime(new Date(entry.createdAt), timeZone)} · ${escapeHtml(entry.dish)} — ${kcal(entry.totalKcal)}`)
      if (entry.userNote) lines.push(`  Not: ${escapeHtml(entry.userNote)}`)
      lines.push(...entry.items.map(itemLine))
    }
  }
  lines.push('', 'Değerler fotoğraftan tahmindir; gerçek kaloriden belirgin sapabilir.')
  return splitLines(lines)
}

/** The ranking for one period: per person the total, then the daily average over logged days. */
export function formatLeaderboard(title: string, rows: LeaderboardRow[]): string {
  const lines = [`<b>Sıralama · ${escapeHtml(title)}</b>`]
  rows.forEach((row, index) => {
    lines.push('', `${index + 1}. <b>${escapeHtml(row.userName)}</b> — ${kcal(row.totalKcal)}`)
    lines.push(
      row.days > 1
        ? `    günlük ort. ${kcal(Math.round(row.totalKcal / row.days))} · ${row.days} gün · ${row.entries} kayıt`
        : `    ${row.entries} kayıt`,
    )
  })
  lines.push('', 'Toplam kaloriye göre, çoktan aza. Yalnızca fotoğrafı atılan öğünler sayılır.')
  return lines.join('\n')
}
