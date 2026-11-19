import type { Confidence, Estimate, FoodItem, VisionClient } from './types.ts'

/** The model could not be reached or its reply was not a usable estimate. Never carries secrets. */
export class VisionError extends Error {}

const PROMPT = `Sen bir beslenme asistanısın. Fotoğraftaki yiyecek ve içeceklerin kalorisini tahmin et.
Kurallar:
- Porsiyonu tabak, çatal, el gibi referanslardan tahmin et; emin değilsen tipik bir porsiyon varsay.
- Görünen her kalemi ayrı yaz; pişirme yağını ve sosları dahil et.
- Kullanıcı notu varsa ona öncelik ver (porsiyon, içerik, marka, "yarısını yedim" gibi). Not fotoğraftan farklı bir miktar söylüyorsa notu esas al ve yalnızca yenen miktarı hesapla.
- Adetle sayılan yiyeceklerde (yumurta, dilim, köfte, meyve, bardak) "count" alanına yenen adedi yaz; sayılamıyorsa null yaz.
- Fotoğrafta yiyecek veya içecek yoksa "is_food": false döndür.
- İsimler Türkçe olsun. Yalnızca JSON döndür, başka hiçbir şey yazma.
Şema:
{"is_food": boolean, "dish": "kısa yemek adı", "items": [{"name": string, "count": number | null, "grams": number, "kcal": number, "protein_g": number, "carbs_g": number, "fat_g": number}], "total_kcal": number, "confidence": "düşük" | "orta" | "yüksek", "note": "neyi hangi miktarda saydığının tek cümlesi"}`

const MAX_KCAL = 10_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** A finite, non-negative number, or null. Accepts numeric strings ("250", "12,5"). */
function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** Sum of a macro across items; null unless every item reports it. */
function sumOrNull(items: FoodItem[], pick: (i: FoodItem) => number | null): number | null {
  if (items.length === 0) return null
  let total = 0
  for (const item of items) {
    const value = pick(item)
    if (value === null) return null
    total += value
  }
  return Math.round(total)
}

/** First balanced {...} block in free text (string-aware), so code fences and chatter are tolerated. */
function extractJson(content: string): string | null {
  const start = content.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < content.length; i++) {
    const ch = content[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return content.slice(start, i + 1)
  }
  return null
}

/**
 * Turns the model's reply into an Estimate. The total is the sum of the items whenever items are
 * present, so the per-item breakdown in the report always adds up to the total shown.
 */
export function parseEstimate(content: string): Estimate {
  const block = extractJson(content)
  if (!block) throw new VisionError('model JSON döndürmedi')
  let data: unknown
  try {
    data = JSON.parse(block)
  } catch {
    throw new VisionError('model geçersiz JSON döndürdü')
  }
  if (!isRecord(data)) throw new VisionError('model geçersiz JSON döndürdü')

  const items: FoodItem[] = []
  for (const raw of Array.isArray(data.items) ? data.items : []) {
    if (!isRecord(raw)) continue
    const name = text(raw.name)
    const kcal = num(raw.kcal)
    if (!name || kcal === null) continue
    items.push({
      name,
      count: num(raw.count) || null,
      grams: num(raw.grams),
      kcal: Math.round(kcal),
      proteinG: num(raw.protein_g),
      carbsG: num(raw.carbs_g),
      fatG: num(raw.fat_g),
    })
  }

  const stated = num(data.total_kcal)
  const totalKcal = items.length > 0 ? items.reduce((sum, i) => sum + i.kcal, 0) : stated === null ? 0 : Math.round(stated)
  const isFood = data.is_food !== false && totalKcal > 0
  if (data.is_food !== false && !isFood) throw new VisionError('model kalori vermedi')
  if (totalKcal > MAX_KCAL) throw new VisionError('model gerçek dışı bir kalori verdi')

  const confidence = text(data.confidence)?.toLocaleLowerCase('tr-TR')
  return {
    isFood,
    dish: text(data.dish) ?? items[0]?.name ?? 'Yemek',
    items,
    totalKcal,
    proteinG: sumOrNull(items, (i) => i.proteinG),
    carbsG: sumOrNull(items, (i) => i.carbsG),
    fatG: sumOrNull(items, (i) => i.fatG),
    confidence: confidence === 'düşük' || confidence === 'orta' || confidence === 'yüksek' ? (confidence as Confidence) : null,
    note: text(data.note),
  }
}

export interface VisionOptions {
  baseUrl: string
  apiKey: string
  model: string
  fetchFn?: typeof fetch
  timeoutMs?: number
  /** Pauses before each retry of a transient failure; length = number of retries. */
  retryDelaysMs?: number[]
}

/** Calorie estimator over an OpenAI-compatible chat-completions endpoint (the local CLIProxyAPI). */
export function createVisionClient(opts: VisionOptions): VisionClient {
  const fetchFn = opts.fetchFn ?? fetch
  const timeoutMs = opts.timeoutMs ?? 60_000
  const retryDelaysMs = opts.retryDelaysMs ?? [2_000, 6_000]

  async function once(body: string): Promise<{ retry: boolean; error: string } | { content: string }> {
    let res: Response
    try {
      res = await fetchFn(`${opts.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      return { retry: true, error: e instanceof Error && e.name === 'TimeoutError' ? 'zaman aşımı' : 'proxy erişilemiyor' }
    }
    if (!res.ok) {
      await res.body?.cancel()
      return { retry: res.status === 429 || res.status >= 500, error: `proxy HTTP ${res.status}` }
    }
    const data: unknown = await res.json().catch(() => null)
    const choice = isRecord(data) && Array.isArray(data.choices) ? data.choices[0] : undefined
    const message = isRecord(choice) ? choice.message : undefined
    const content = isRecord(message) ? message.content : undefined
    return typeof content === 'string' && content.trim()
      ? { content }
      : { retry: true, error: 'proxy boş yanıt döndürdü' }
  }

  return {
    async estimate(image, mime, note) {
      const body = JSON.stringify({
        model: opts.model,
        temperature: 0.2,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: note ? `${PROMPT}\n\nKullanıcı notu: ${JSON.stringify(note)}` : PROMPT },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${Buffer.from(image).toString('base64')}` } },
            ],
          },
        ],
      })
      for (let attempt = 0; ; attempt++) {
        const result = await once(body)
        if ('content' in result) return { estimate: parseEstimate(result.content), raw: result.content }
        const delay = retryDelaysMs[attempt]
        if (!result.retry || delay === undefined) throw new VisionError(result.error)
        await Bun.sleep(delay)
      }
    },
  }
}
