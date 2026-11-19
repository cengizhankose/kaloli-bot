# Architecture

One Bun process. It long-polls Telegram, calls a vision model over HTTP, and keeps everything in one SQLite file. There is no web server, no queue and no runtime dependency beyond Bun's built-ins (`bun:sqlite`, `fetch`).

## Modules

| File | Responsibility |
|---|---|
| `src/index.ts` | Loads config, opens the store, runs the long-poll loop and the 30-second report timer. The only file with side effects at import. |
| `src/bot.ts` | `handleUpdate` (commands, trigger detection, analysis flow) and `sendDueReports`. Depends on interfaces only, so tests drive it with fakes. |
| `src/vision.ts` | The prompt, the chat-completions call with timeout and retries, and `parseEstimate`, which turns the model's reply into a validated `Estimate`. |
| `src/telegram.ts` | Minimal Bot API client: `getMe`, `getUpdates`, `sendMessage`, `sendChatAction`, file download. |
| `src/db.ts` | Schema and every query, behind the `Store` class. |
| `src/format.ts` | Reply, daily report and leaderboard text (Telegram HTML), message splitting. |
| `src/config.ts` | `.env` parsing and validation. |
| `src/dates.ts` | Time-zone and calendar helpers. |

## Flow of one photo

1. `getUpdates` returns a message. Messages from bots and from chats outside `ALLOWED_CHAT_IDS` are dropped (`/chatid` is the one exception, so a new group's id can be learned).
2. A photo is analysed when its caption tags the bot (`@bot`, or a leading `/kalori`), or when someone replies to it with a tag. In `TRIGGER_MODE=all` every photo is analysed.
3. The largest photo size is downloaded and sent to the model with the note: the caption minus the tag, plus the replying text if any.
4. `parseEstimate` validates the reply. Not food: the bot says so and stores nothing. Unusable reply or unreachable model: the bot asks to retry and stores nothing.
5. The entry and its items are written in one transaction; the bot replies under the photo and records its own message id so `/sil` can target either message.
6. The update offset is persisted after each update.

## Data model

SQLite in WAL mode, `data/kalori.db` by default.

| Table | Purpose | Key |
|---|---|---|
| `entries` | One estimate per photo message: who, when, which local day, note, dish, totals, confidence, the model's assumption, model name and raw reply. | `UNIQUE (chat_id, message_id)` |
| `items` | Per-item breakdown of an entry: name, piece count, grams, kcal, macros. Deleted with its entry. | `entry_id` |
| `reports` | Which daily reports were sent. | `(chat_id, day)` |
| `meta` | Key/value; holds the Telegram update offset. | `key` |

`Store` adds the `items.count` column to databases created before it existed.

## Rules the code keeps

- **One entry per photo.** Re-analysing a photo replaces its entry, so a corrected note never double counts.
- **The total is the sum of the items.** When the model returns items, its own `total_kcal` is ignored, so the breakdown shown always adds up. `total_kcal` is used only when no usable item came back.
- **A meal belongs to the photo's sender and the photo's local day**, even when someone else triggers the analysis later.
- **A day's macro total is shown only if every entry has macros.** A partial sum would look like a complete one.
- **Only the sender can delete their entry.**
- **A report is marked sent only after Telegram accepted it.** A failed send is retried on the next 30-second tick. Reports for the last 3 days are caught up after downtime.
- **Updates are neither replayed nor skipped across restarts**, because the offset is stored after each handled update.
- **The allowlist fails closed.** An empty `ALLOWED_CHAT_IDS` means no photo reaches the model.
- **Secrets stay out of errors and logs.** Telegram errors carry the method name only (fetch errors can embed the token-bearing URL); vision errors carry the HTTP status only.
- **Implausible estimates are rejected**: no calories, or more than 10 000 kcal for one photo.

## Failure handling

| Situation | Behaviour |
|---|---|
| Vision endpoint returns 429 or 5xx, times out (60 s), or sends an empty body | Retried after 2 s and 6 s, then the user is asked to tag the photo again. |
| Vision endpoint returns another 4xx | No retry; logged as `proxy HTTP <status>`. |
| Telegram `getUpdates` fails | Logged, retried after 5 s. |
| Telegram answers 409 | Another instance is polling with the same token; retried every 30 s. |
| Telegram rate limit with `retry_after` up to 30 s | Waited once, then retried. |
| Message longer than Telegram allows | Split on line boundaries, so HTML tags never break. |
| Process exits | The LaunchAgent restarts it; pending updates are still queued at Telegram. |

## Tests

`test/bot.test.ts` drives `handleUpdate` and `sendDueReports` with an in-memory store, a fake Telegram and a fake model. It covers trigger detection, the allowlist, reply-to-photo attribution, replacement on re-analysis, non-food and failure paths, deletion rights, report timing and catch-up, leaderboard windows, reply parsing, retry behaviour and the schema upgrade.
