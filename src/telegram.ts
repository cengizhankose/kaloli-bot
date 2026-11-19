import { MAX_MESSAGE, splitLines } from './format.ts'
import type { TelegramApi, TgUpdate, TgUser } from './types.ts'

/** A failed Bot API call. The message names the method only; it never contains the token or a URL. */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    /** Bot API error_code (e.g. 409 = another instance is polling), or null for a network failure. */
    readonly code: number | null,
    description: string,
  ) {
    super(`${method}: ${description}`)
  }
}

interface ApiResponse<T> {
  ok: boolean
  result?: T
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

const API = 'https://api.telegram.org'

export class Telegram implements TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await this.fetchFn(`${API}/bot${this.token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (e) {
        // fetch errors can embed the request URL (and so the token): keep only the error name.
        throw new TelegramError(method, null, e instanceof Error ? e.name : 'network error')
      }
      const body = (await res.json().catch(() => null)) as ApiResponse<T> | null
      if (body?.ok && body.result !== undefined) return body.result
      const retryAfter = body?.parameters?.retry_after
      if (res.status === 429 && retryAfter !== undefined && retryAfter <= 30 && attempt === 0) {
        await Bun.sleep(retryAfter * 1000)
        continue
      }
      throw new TelegramError(method, body?.error_code ?? res.status, body?.description ?? `HTTP ${res.status}`)
    }
  }

  getMe(): Promise<TgUser> {
    return this.call('getMe', {})
  }

  /** Long poll: resolves as soon as updates exist, or empty after `timeoutSec`. */
  getUpdates(offset: number | undefined, timeoutSec: number): Promise<TgUpdate[]> {
    return this.call(
      'getUpdates',
      { offset, timeout: timeoutSec, allowed_updates: ['message'] },
      (timeoutSec + 15) * 1000,
    )
  }

  async sendMessage(chatId: number, html: string, replyTo?: number): Promise<number> {
    let lastId = 0
    for (const text of splitLines(html.split('\n'), MAX_MESSAGE)) {
      const sent = await this.call<{ message_id: number }>('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_parameters:
          replyTo === undefined ? undefined : { message_id: replyTo, allow_sending_without_reply: true },
      })
      lastId = sent.message_id
    }
    return lastId
  }

  async sendTyping(chatId: number): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action: 'typing' })
  }

  async downloadFile(fileId: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId })
    if (!file.file_path) throw new TelegramError('getFile', null, 'file_path yok')
    let res: Response
    try {
      res = await this.fetchFn(`${API}/file/bot${this.token}/${file.file_path}`, { signal: AbortSignal.timeout(60_000) })
    } catch (e) {
      throw new TelegramError('downloadFile', null, e instanceof Error ? e.name : 'network error')
    }
    if (!res.ok) throw new TelegramError('downloadFile', res.status, `HTTP ${res.status}`)
    const ext = file.file_path.split('.').pop()?.toLowerCase()
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    return { bytes: new Uint8Array(await res.arrayBuffer()), mime }
  }
}
