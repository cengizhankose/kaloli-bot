# Operations

## First-time setup

### 1. Create the bot

1. Open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Give it a display name and a username ending in `bot`.
3. Copy `.env.example` to `.env` and put the token in `TELEGRAM_BOT_TOKEN`. Keep `.env` out of chats and commits; it is git-ignored.

### 2. Disable privacy mode

In BotFather: `/setprivacy`, pick the bot, **Disable**. Do it before adding the bot to a group; if you change it later, remove the bot from the group and add it again.

This is the configuration the bot has been run with. With privacy mode on, Telegram's documentation does not state that tagged photo captions reach the bot, and that path is untested.

### 3. Vision endpoint

Set `PROXY_API_KEY`, and `PROXY_BASE_URL` if the endpoint is not `http://127.0.0.1:8317`. The endpoint must serve `POST /v1/chat/completions` with image input for the model named in `VISION_MODEL`.

### 4. Allowlist the group

1. Start the bot (`bun run start` or `bin/service install`).
2. Create the group, add the bot as a normal member.
3. Send `/chatid` in the group.
4. Put the number, minus sign included, into `ALLOWED_CHAT_IDS` and restart the bot.

Several groups: separate the ids with commas. Data is kept per chat.

## Running as a service (macOS)

```bash
bin/service install      # writes ~/Library/LaunchAgents/com.kaloli.bot.plist and starts it
bin/service status       # state, pid, last exit code
bin/service logs 100     # last lines of ~/Library/Logs/kaloli-bot/bot.log
bin/service restart      # after editing .env or pulling new code
bin/service uninstall
```

The agent starts at login and restarts the bot if it exits. `install` records the absolute path of the repo and of `bun`, so run it again after moving either.

A sleeping Mac runs nothing. Messages sent meanwhile wait at Telegram and are handled on wake; a daily report that came due during sleep is sent on wake, for up to 3 days back.

A healthy start logs one line:

```text
2026-11-19T22:19:42.546Z başladı @kaloli_bot model=gemini-3.5-flash-lite tetik=mention rapor=23:55 izinli_chat=1
```

`izinli_chat=0` means the allowlist is empty.

## Changing settings

Edit `.env`, then `bin/service restart`. See the configuration table in the [README](../README.md#configuration).

- **Another model:** set `VISION_MODEL` to any image-capable model the endpoint serves.
- **Analyse every photo without a tag:** `TRIGGER_MODE=all`. Non-food photos then get a "no food found" reply each time.
- **Report time:** `REPORT_TIME=HH:MM` in `TIMEZONE`.

## Data

The database is `data/kalori.db` plus its `-wal` and `-shm` files. Move or copy all three together, or use a backup.

```bash
# consistent backup while the bot runs
sqlite3 data/kalori.db ".backup data/backup-$(date +%F).db"

# what was logged today
sqlite3 -header -column data/kalori.db \
  "SELECT user_name, substr(created_at, 12, 5) AS utc, dish, total_kcal, user_note
   FROM entries WHERE day = date('now', 'localtime') ORDER BY created_at;"

# what the model answered for one entry
sqlite3 data/kalori.db "SELECT raw_response FROM entries WHERE id = 1;"
```

Start over (keeps the Telegram offset, so old messages are not replayed):

```bash
sqlite3 data/kalori.db ".backup data/before-reset.db"
sqlite3 data/kalori.db "DELETE FROM items; DELETE FROM entries; DELETE FROM reports;"
```

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| Bot is silent in the group, `/chatid` still answers | The chat is not allowlisted. Telegram changes a group's id when it becomes a supergroup (for example after making history visible to new members). | Send `/chatid` again, update `ALLOWED_CHAT_IDS`, restart. |
| Bot does not react to tagged photos at all | Privacy mode is on, or was turned off after the bot joined. | Disable it in BotFather, remove and re-add the bot. |
| "Tahmin yapılamadı…" under a photo | The vision endpoint was unreachable or returned an unusable reply three times. | Check the endpoint; `bin/service logs` shows `analiz hatası … proxy HTTP <status>` or `zaman aşımı`. Tag the photo again afterwards. |
| Log repeats `başka bir kopya aynı tokenla çalışıyor (409)` | Two processes poll with the same token. | Stop the other one. |
| The estimate ignored a note | The note is passed verbatim; check what the model assumed in the reply's "Varsayım" line or in `raw_response`. | Reply to the photo with the tag and a clearer note; the estimate is replaced. |
| No daily report | No entries that day, the machine was off for more than 3 days, or sending failed. | `bin/service logs` shows `rapor gönderildi` or `rapor hatası`. `/rapor` prints today's on demand. |
| Service will not start | Missing or invalid `.env` value. | The log names the variable. |
