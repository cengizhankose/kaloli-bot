// Minimal Telegram Bot API shapes this bot reads. Fields it never touches are left out.
export interface TgUser {
  id: number
  is_bot?: boolean
  first_name: string
  last_name?: string
  username?: string
}

export interface TgPhotoSize {
  file_id: string
  width: number
  height: number
  file_size?: number
}

export interface TgMessage {
  message_id: number
  /** Unix seconds. */
  date: number
  chat: { id: number; type: string; title?: string }
  from?: TgUser
  text?: string
  caption?: string
  photo?: TgPhotoSize[]
  reply_to_message?: TgMessage
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
}

/** The slice of the Bot API the message handler needs; faked in tests. */
export interface TelegramApi {
  /** Sends HTML text (split on line breaks if too long); returns the last sent message id. */
  sendMessage(chatId: number, html: string, replyTo?: number): Promise<number>
  sendTyping(chatId: number): Promise<void>
  downloadFile(fileId: string): Promise<{ bytes: Uint8Array; mime: string }>
}

export interface FoodItem {
  name: string
  grams: number | null
  /** How many pieces were eaten (eggs, slices…); null when the food is not counted. */
  count: number | null
  kcal: number
  proteinG: number | null
  carbsG: number | null
  fatG: number | null
}

export type Confidence = 'düşük' | 'orta' | 'yüksek'

export interface Estimate {
  isFood: boolean
  dish: string
  items: FoodItem[]
  totalKcal: number
  proteinG: number | null
  carbsG: number | null
  fatG: number | null
  confidence: Confidence | null
  note: string | null
}

export interface VisionResult {
  estimate: Estimate
  /** The model's unparsed reply, stored with the entry for later audit. */
  raw: string
}

export interface VisionClient {
  estimate(image: Uint8Array, mime: string, note: string | null): Promise<VisionResult>
}
