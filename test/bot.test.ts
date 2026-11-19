import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractTrigger, handleUpdate, parseCommand, sendDueReports, type BotDeps } from '../src/bot.ts'
import { Store } from '../src/db.ts'
import { buildDailyReport, splitLines } from '../src/format.ts'
import type { Estimate, TelegramApi, TgMessage, TgUser, VisionClient } from '../src/types.ts'
import { VisionError, createVisionClient, parseEstimate } from '../src/vision.ts'

const CHAT = -1001
const TZ = 'Europe/Istanbul'
const ALI: TgUser = { id: 1, first_name: 'Ali' }
const VELI: TgUser = { id: 2, first_name: 'Veli', last_name: 'Kaya' }
/** 2026-11-18 12:40 in Istanbul (UTC+3). */
const NOON = Date.UTC(2026, 10, 18, 9, 40) / 1000

const PILAV: Estimate = {
  isFood: true,
  dish: 'Tavuklu pilav',
  items: [
    { name: 'Pirinç pilavı', count: null, grams: 200, kcal: 260, proteinG: 5, carbsG: 56, fatG: 2 },
    { name: 'Tavuk göğsü', count: null, grams: 120, kcal: 198, proteinG: 37, carbsG: 0, fatG: 4 },
  ],
  totalKcal: 458,
  proteinG: 42,
  carbsG: 56,
  fatG: 6,
  confidence: 'orta',
  note: null,
}

function setup(overrides: Partial<BotDeps> = {}, estimate: Estimate | Error = PILAV) {
  const sent: { chatId: number; html: string; replyTo?: number }[] = []
  const notes: (string | null)[] = []
  let nextId = 9000
  const tg: TelegramApi = {
    async sendMessage(chatId, html, replyTo) {
      sent.push({ chatId, html, replyTo })
      return nextId++
    },
    async sendTyping() {},
    async downloadFile() {
      return { bytes: new Uint8Array([1, 2, 3]), mime: 'image/jpeg' }
    },
  }
  const vision: VisionClient = {
    async estimate(_image, _mime, note) {
      notes.push(note)
      if (estimate instanceof Error) throw estimate
      return { estimate, raw: '{}' }
    },
  }
  const store = new Store(':memory:')
  const deps: BotDeps = {
    store,
    tg,
    vision,
    botUsername: 'kalori_bot',
    allowedChatIds: new Set([CHAT]),
    timezone: TZ,
    triggerMode: 'mention',
    model: 'test-model',
    now: () => new Date(NOON * 1000),
    ...overrides,
  }
  return { deps, store, sent, notes }
}

function photo(id: number, from: TgUser, caption?: string, date = NOON, chatId = CHAT): TgMessage {
  return {
    message_id: id,
    date,
    chat: { id: chatId, type: 'supergroup' },
    from,
    caption,
    photo: [
      { file_id: 'small', width: 90, height: 90 },
      { file_id: 'large', width: 1280, height: 960 },
    ],
  }
}

function textMessage(id: number, from: TgUser, text: string, replyTo?: TgMessage, chatId = CHAT): TgMessage {
  return { message_id: id, date: NOON + 60, chat: { id: chatId, type: 'supergroup' }, from, text, reply_to_message: replyTo }
}

describe('extractTrigger', () => {
  test('a mention triggers and is stripped from the note', () => {
    expect(extractTrigger('@Kalori_Bot yarım porsiyon', 'kalori_bot')).toEqual({ triggered: true, note: 'yarım porsiyon' })
    expect(extractTrigger('öğle yemeği @kalori_bot', 'kalori_bot')).toEqual({ triggered: true, note: 'öğle yemeği' })
    expect(extractTrigger('@kalori_bot', 'kalori_bot')).toEqual({ triggered: true, note: null })
  })

  test('a longer username or a plain caption does not trigger', () => {
    expect(extractTrigger('@kalori_bot2 bak', 'kalori_bot').triggered).toBe(false)
    expect(extractTrigger('akşam yemeği', 'kalori_bot')).toEqual({ triggered: false, note: 'akşam yemeği' })
    expect(extractTrigger(undefined, 'kalori_bot')).toEqual({ triggered: false, note: null })
  })

  test('/kalori triggers with or without the bot suffix', () => {
    expect(extractTrigger('/kalori 2 dilim', 'kalori_bot')).toEqual({ triggered: true, note: '2 dilim' })
    expect(extractTrigger('/kalori@kalori_bot', 'kalori_bot')).toEqual({ triggered: true, note: null })
    expect(extractTrigger('/kalori@baska_bot', 'kalori_bot').triggered).toBe(false)
  })
})

test('parseCommand ignores commands addressed to another bot', () => {
  expect(parseCommand('/rapor', 'kalori_bot')).toEqual({ name: 'rapor', args: '' })
  expect(parseCommand('/Sil@Kalori_Bot', 'kalori_bot')).toEqual({ name: 'sil', args: '' })
  expect(parseCommand('/rapor@baska_bot', 'kalori_bot')).toBeNull()
  expect(parseCommand('rapor', 'kalori_bot')).toBeNull()
})

describe('parseEstimate', () => {
  test('reads fenced JSON and totals the items rather than trusting total_kcal', () => {
    const e = parseEstimate(
      '```json\n{"is_food": true, "dish": "Menemen", "items": [{"name": "Yumurta", "count": 2, "grams": 100, "kcal": 150.4, "protein_g": 12, "carbs_g": 1, "fat_g": 10}, {"name": "Ekmek", "count": 0, "grams": "50", "kcal": "130"}], "total_kcal": 999, "confidence": "Yüksek"}\n```',
    )
    expect(e.totalKcal).toBe(280)
    expect(e.items.map((i) => i.kcal)).toEqual([150, 130])
    expect(e.items[1]?.grams).toBe(50)
    expect(e.items.map((i) => i.count)).toEqual([2, null])
    expect(e.confidence).toBe('yüksek')
    expect(e.proteinG).toBeNull() // bread has no macros, so a day total would be misleading
  })

  test('falls back to total_kcal when there are no usable items', () => {
    expect(parseEstimate('{"is_food": true, "dish": "Çorba", "items": [{"name": "x"}], "total_kcal": 180}').totalKcal).toBe(180)
  })

  test('reports non-food without throwing', () => {
    expect(parseEstimate('{"is_food": false, "items": [], "total_kcal": 0}').isFood).toBe(false)
  })

  test('rejects replies that carry no estimate', () => {
    expect(() => parseEstimate('Üzgünüm, göremiyorum.')).toThrow(VisionError)
    expect(() => parseEstimate('{"is_food": true, "items": []}')).toThrow(VisionError)
    expect(() => parseEstimate('{"is_food": true, "total_kcal": 50000}')).toThrow(VisionError)
    expect(() => parseEstimate('{"is_food": true, "total_kcal": ')).toThrow(VisionError)
  })
})

describe('vision client', () => {
  const ok = { choices: [{ message: { content: '{"is_food": true, "dish": "Elma", "total_kcal": 80}' } }] }

  test('sends the note and image, and retries a transient failure', async () => {
    const bodies: string[] = []
    let calls = 0
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return ++calls === 1 ? new Response('busy', { status: 503 }) : Response.json(ok)
    }) as typeof fetch
    const client = createVisionClient({ baseUrl: 'http://x', apiKey: 'k', model: 'm', fetchFn, retryDelaysMs: [0] })
    const { estimate } = await client.estimate(new Uint8Array([255, 216]), 'image/jpeg', 'yarım "elma"')
    expect(estimate.totalKcal).toBe(80)
    expect(calls).toBe(2)
    const content = JSON.parse(bodies[0]!).messages[0].content
    expect(content[0].text).toContain('Kullanıcı notu: "yarım \\"elma\\""')
    expect(content[1].image_url.url).toBe('data:image/jpeg;base64,/9g=')
  })

  test('does not retry a client error and never leaks the key', async () => {
    let calls = 0
    const fetchFn = (async () => {
      calls++
      return new Response('bad key sk-secret', { status: 401 })
    }) as unknown as typeof fetch
    const client = createVisionClient({ baseUrl: 'http://x', apiKey: 'sk-secret', model: 'm', fetchFn, retryDelaysMs: [0, 0] })
    const error = await client.estimate(new Uint8Array(), 'image/jpeg', null).catch((e: Error) => e)
    expect(error).toBeInstanceOf(VisionError)
    expect((error as Error).message).toBe('proxy HTTP 401')
    expect(calls).toBe(1)
  })
})

describe('handleUpdate', () => {
  test('a tagged photo is analysed, stored under its sender and answered', async () => {
    const { deps, store, sent, notes } = setup()
    await handleUpdate({ update_id: 1, message: photo(10, ALI, '@kalori_bot yarım porsiyon') }, deps)

    expect(notes).toEqual(['yarım porsiyon'])
    const [entry] = store.entriesForDay(CHAT, '2026-11-18')
    expect(entry).toMatchObject({ userId: 1, userName: 'Ali', dish: 'Tavuklu pilav', totalKcal: 458, userNote: 'yarım porsiyon' })
    expect(entry?.items).toHaveLength(2)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.replyTo).toBe(10)
    expect(sent[0]?.html).toContain('Tavuklu pilav · ~458 kcal')
    expect(sent[0]?.html).toContain('Ali · bugün toplam 458 kcal')
  })

  test('the answer shows how many pieces were counted and the model assumption', async () => {
    const eggs: Estimate = {
      ...PILAV,
      dish: 'Haşlanmış yumurta',
      items: [
        { name: 'Haşlanmış yumurta', count: 2, grams: 100, kcal: 155, proteinG: 13, carbsG: 1, fatG: 11 },
        { name: 'Ekmek', count: 0.5, grams: null, kcal: 40, proteinG: 1, carbsG: 8, fatG: 0 },
      ],
      totalKcal: 195,
      note: "5 yumurtadan 2'si sayıldı <not>.",
    }
    const { deps, store, sent } = setup({}, eggs)
    await handleUpdate({ update_id: 1, message: photo(10, ALI, '@kalori_bot 5 yumurta vardı 2 tanesini yedim') }, deps)

    expect(sent[0]?.html).toContain('• Haşlanmış yumurta, 2 adet · 100 g — 155 kcal')
    expect(sent[0]?.html).toContain('• Ekmek, 0,5 adet — 40 kcal')
    expect(sent[0]?.html).toContain("Varsayım: 5 yumurtadan 2'si sayıldı &lt;not&gt;.")
    const report = buildDailyReport('2026-11-18', store.entriesForDay(CHAT, '2026-11-18'), TZ).join('\n')
    expect(report).toContain('• Haşlanmış yumurta, 2 adet · 100 g — 155 kcal')
  })

  test('a database created before item counts existed is upgraded in place', () => {
    const path = join(tmpdir(), `kalori-test-${crypto.randomUUID()}.db`)
    try {
      const old = new Database(path, { create: true })
      old.exec(
        'CREATE TABLE items (id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL, grams REAL, kcal INTEGER NOT NULL, protein_g REAL, carbs_g REAL, fat_g REAL)',
      )
      old.close()

      const store = new Store(path)
      store.upsertEntry({
        chatId: CHAT, messageId: 1, userId: 1, userName: 'Ali', day: '2026-11-18', createdAt: new Date(NOON * 1000).toISOString(),
        userNote: null, fileId: 'f', model: 'm', rawResponse: '{}',
        estimate: { ...PILAV, items: [{ ...PILAV.items[0]!, count: 3 }], totalKcal: 260 },
      })
      expect(store.entriesForDay(CHAT, '2026-11-18')[0]?.items[0]?.count).toBe(3)
      store.close()
    } finally {
      for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true })
    }
  })

  test('an untagged photo is ignored in mention mode and analysed in all mode', async () => {
    const mention = setup()
    await handleUpdate({ update_id: 1, message: photo(10, ALI, 'manzara') }, mention.deps)
    expect(mention.store.entriesForDay(CHAT, '2026-11-18')).toHaveLength(0)
    expect(mention.sent).toHaveLength(0)

    const all = setup({ triggerMode: 'all' })
    await handleUpdate({ update_id: 1, message: photo(10, ALI, 'köfte') }, all.deps)
    expect(all.store.entriesForDay(CHAT, '2026-11-18')).toHaveLength(1)
    expect(all.notes).toEqual(['köfte'])
  })

  test('a chat outside the allowlist gets no analysis, only /chatid', async () => {
    const { deps, store, sent, notes } = setup()
    await handleUpdate({ update_id: 1, message: photo(10, ALI, '@kalori_bot', NOON, -555) }, deps)
    await handleUpdate({ update_id: 2, message: textMessage(11, ALI, '/rapor', undefined, -555) }, deps)
    expect(notes).toHaveLength(0)
    expect(store.entriesForDay(-555, '2026-11-18')).toHaveLength(0)
    expect(sent).toHaveLength(0)

    await handleUpdate({ update_id: 3, message: textMessage(12, ALI, '/chatid', undefined, -555) }, deps)
    expect(sent[0]?.html).toContain('-555')
  })

  test('replying to a photo with a tag records it for the photo sender, on the photo day', async () => {
    const { deps, store, notes } = setup()
    const yesterday = photo(10, ALI, 'akşam', NOON - 20 * 3600) // 2026-11-17 16:40 local
    await handleUpdate({ update_id: 1, message: textMessage(11, VELI, '@kalori_bot ekmeksiz', yesterday) }, deps)

    expect(notes).toEqual(['akşam · ekmeksiz'])
    expect(store.entriesForDay(CHAT, '2026-11-18')).toHaveLength(0)
    expect(store.entriesForDay(CHAT, '2026-11-17')[0]).toMatchObject({ userId: 1, messageId: 10 })
  })

  test('analysing the same photo again replaces the estimate instead of double counting', async () => {
    const { deps, store, sent } = setup()
    const p = photo(10, ALI, '@kalori_bot')
    await handleUpdate({ update_id: 1, message: p }, deps)
    await handleUpdate({ update_id: 2, message: textMessage(11, ALI, '@kalori_bot yarısını yedim', p) }, deps)

    const entries = store.entriesForDay(CHAT, '2026-11-18')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.userNote).toBe('yarısını yedim')
    expect(store.dayTotalKcal(CHAT, 1, '2026-11-18')).toBe(458)
    expect(sent[1]?.html).toContain('Önceki tahmin güncellendi.')
  })

  test('a non-food photo and a model failure store nothing and say so', async () => {
    const notFood = setup({}, { ...PILAV, isFood: false, items: [], totalKcal: 0 })
    await handleUpdate({ update_id: 1, message: photo(10, ALI, '@kalori_bot') }, notFood.deps)
    expect(notFood.store.entriesForDay(CHAT, '2026-11-18')).toHaveLength(0)
    expect(notFood.sent[0]?.html).toContain('yiyecek göremedim')

    const failed = setup({}, new VisionError('proxy HTTP 503'))
    await handleUpdate({ update_id: 1, message: photo(10, ALI, '@kalori_bot') }, failed.deps)
    expect(failed.store.entriesForDay(CHAT, '2026-11-18')).toHaveLength(0)
    expect(failed.sent[0]?.html).toContain('Tahmin yapılamadı')
  })

  test('/sil removes an entry only for its owner, via the photo or the bot answer', async () => {
    const { deps, store, sent } = setup()
    const p = photo(10, ALI, '@kalori_bot')
    await handleUpdate({ update_id: 1, message: p }, deps)
    const botAnswer: TgMessage = { message_id: 9000, date: NOON, chat: p.chat, from: { id: 99, is_bot: true, first_name: 'bot' } }

    await handleUpdate({ update_id: 2, message: textMessage(11, VELI, '/sil', botAnswer) }, deps)
    expect(store.entriesForDay(CHAT, '2026-11-18')).toHaveLength(1)
    expect(sent.at(-1)?.html).toContain('yalnızca fotoğrafı atan')

    await handleUpdate({ update_id: 3, message: textMessage(12, ALI, '/sil@kalori_bot', botAnswer) }, deps)
    expect(store.entriesForDay(CHAT, '2026-11-18')).toHaveLength(0)
  })

  test('/rapor lists today per person with items', async () => {
    const { deps, sent } = setup()
    await handleUpdate({ update_id: 1, message: photo(10, VELI, '@kalori_bot') }, deps)
    await handleUpdate({ update_id: 2, message: photo(11, ALI, '@kalori_bot') }, deps)
    await handleUpdate({ update_id: 3, message: photo(12, ALI, '@kalori_bot tatlı', NOON + 3600) }, deps)
    sent.length = 0
    await handleUpdate({ update_id: 4, message: textMessage(13, ALI, '/rapor') }, deps)

    const report = sent.map((s) => s.html).join('\n')
    expect(report).toContain('Günlük rapor · 18 Kasım Çarşamba')
    expect(report).toContain('<b>Ali — 916 kcal</b> (2 kayıt)')
    expect(report).toContain('<b>Veli Kaya — 458 kcal</b> (1 kayıt)')
    expect(report.indexOf('Ali —')).toBeLessThan(report.indexOf('Veli Kaya —'))
    expect(report).toContain('12:40 · Tavuklu pilav — 458 kcal')
    expect(report).toContain('13:40 · Tavuklu pilav — 458 kcal')
    expect(report).toContain('Not: tatlı')
    expect(report).toContain('• Tavuk göğsü 120 g — 198 kcal')
    expect(report).toContain('P 84 g · K 112 g · Y 12 g')
  })
})

describe('sendDueReports', () => {
  const at = (hour: number, minute: number, day = 18) => new Date(Date.UTC(2026, 10, day, hour - 3, minute))

  test('sends today once after the report time and never twice', async () => {
    const { deps, sent } = setup()
    await handleUpdate({ update_id: 1, message: photo(10, ALI, '@kalori_bot') }, deps)
    sent.length = 0

    await sendDueReports(deps, '23:55', at(23, 54))
    expect(sent).toHaveLength(0)
    await sendDueReports(deps, '23:55', at(23, 55))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.html).toContain('Günlük rapor · 18 Kasım Çarşamba')
    await sendDueReports(deps, '23:55', at(23, 56))
    expect(sent).toHaveLength(1)
  })

  test('catches up a missed day the next morning, but not days beyond the window', async () => {
    const { deps, sent } = setup()
    await handleUpdate({ update_id: 1, message: photo(10, ALI, '@kalori_bot') }, deps) // 18 Nov
    await handleUpdate({ update_id: 2, message: photo(11, ALI, '@kalori_bot', NOON - 10 * 86400) }, deps) // 8 Nov
    sent.length = 0

    await sendDueReports(deps, '23:55', at(8, 0, 19))
    expect(sent.map((s) => s.html.split('\n')[0])).toEqual(['<b>Günlük rapor · 18 Kasım Çarşamba</b>'])
  })

  test('a failed send leaves the report pending', async () => {
    const { deps, store } = setup()
    await handleUpdate({ update_id: 1, message: photo(10, ALI, '@kalori_bot') }, deps)
    const failing = { ...deps, tg: { ...deps.tg, sendMessage: async () => Promise.reject(new Error('offline')) } }
    await expect(sendDueReports(failing, '23:55', at(23, 58))).rejects.toThrow('offline')
    expect(store.pendingReports('2026-11-18', true, '2026-11-15')).toEqual([{ chatId: CHAT, day: '2026-11-18' }])
  })
})

describe('/siralama', () => {
  async function ask(deps: BotDeps, sent: { html: string }[], text: string): Promise<string> {
    sent.length = 0
    await handleUpdate({ update_id: 99, message: textMessage(900, ALI, text) }, deps)
    return sent.map((s) => s.html).join('\n')
  }

  /** Today is Wed 18 Nov. Ali: Sun 15 (last week), Mon 16, Wed 18. Veli: Wed 18. Each 458 kcal. */
  async function seeded() {
    const ctx = setup()
    await handleUpdate({ update_id: 1, message: photo(10, ALI, '@kalori_bot', NOON - 3 * 86400) }, ctx.deps)
    await handleUpdate({ update_id: 2, message: photo(11, ALI, '@kalori_bot', NOON - 2 * 86400) }, ctx.deps)
    await handleUpdate({ update_id: 3, message: photo(12, ALI, '@kalori_bot') }, ctx.deps)
    await handleUpdate({ update_id: 4, message: photo(13, VELI, '@kalori_bot') }, ctx.deps)
    return ctx
  }

  test('defaults to the Monday-based week, highest total first, with the daily average', async () => {
    const { deps, sent } = await seeded()
    const board = await ask(deps, sent, '/siralama')
    expect(board).toContain('Sıralama · bu hafta (16 Kasım – 18 Kasım)')
    expect(board).toContain('1. <b>Ali</b> — 916 kcal\n    günlük ort. 458 kcal · 2 gün · 2 kayıt')
    expect(board).toContain('2. <b>Veli Kaya</b> — 458 kcal\n    1 kayıt')
  })

  test('bugun, ay and hepsi change the window', async () => {
    const { deps, sent } = await seeded()
    const today = await ask(deps, sent, '/siralama Bugün')
    expect(today).toContain('1. <b>Ali</b> — 458 kcal')
    expect(today).toContain('2. <b>Veli Kaya</b> — 458 kcal') // tie: alphabetical

    const month = await ask(deps, sent, '/siralama@kalori_bot ay')
    expect(month).toContain('Sıralama · Kasım 2026')
    expect(month).toContain('1. <b>Ali</b> — 1.374 kcal\n    günlük ort. 458 kcal · 3 gün · 3 kayıt')

    expect(await ask(deps, sent, '/siralama hepsi')).toContain('Sıralama · tüm zamanlar')
  })

  test('an unknown period shows usage and an empty period says so', async () => {
    const { deps, sent } = setup()
    expect(await ask(deps, sent, '/siralama yıl')).toContain('Kullanım: /siralama')
    expect(await ask(deps, sent, '/siralama')).toBe('Bu dönemde kayıt yok.')
  })

  test('a person is listed under their latest name', async () => {
    const { deps, sent } = setup()
    await handleUpdate({ update_id: 1, message: photo(10, ALI, '@kalori_bot', NOON - 3600) }, deps)
    await handleUpdate({ update_id: 2, message: photo(11, { ...ALI, first_name: 'Ali Can' }, '@kalori_bot') }, deps)
    const board = await ask(deps, sent, '/siralama')
    expect(board).toContain('1. <b>Ali Can</b> — 916 kcal')
    expect(board).not.toContain('<b>Ali</b>')
  })
})

test('a long report is split on line boundaries under the Telegram limit', () => {
  const store = new Store(':memory:')
  for (let i = 0; i < 60; i++) {
    store.upsertEntry({
      chatId: CHAT, messageId: i, userId: i % 6, userName: `Kişi ${i % 6}`, day: '2026-11-18',
      createdAt: new Date(NOON * 1000 + i * 60_000).toISOString(), userNote: 'x'.repeat(80), fileId: 'f',
      estimate: PILAV, model: 'm', rawResponse: '{}',
    })
  }
  const chunks = buildDailyReport('2026-11-18', store.entriesForDay(CHAT, '2026-11-18'), TZ)
  expect(chunks.length).toBeGreaterThan(1)
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(4000)
    expect(chunk.split('<b>').length).toBe(chunk.split('</b>').length)
  }
  expect(splitLines(['a', 'b', 'c'], 3)).toEqual(['a\nb', 'c'])
})
