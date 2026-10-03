# brief-board

Major's weekday brief, as a local board. Major posts the brief; you triage it; your
actions go back to Major through a webhook.

Zero dependencies. Node 18+.

```sh
npm start          # serves on config.json's port (default 8787)
npm run demo       # seeds ~6 weeks of fake briefs into data-demo/ and serves them
npm test
```

## Views

- **Today** shows the current brief. The strip under the date has one segment per item and fills in as you clear them.
- **Overview** covers the last 30 days: how many briefs in a row you cleared the same day, median time to act, what Major sent by lane, what you did with it, an activity calendar, and items still open after more than a day.
- **Archive** has every brief by day with what happened to each item, full-text search, and filters for snoozed, done and dismissed items. Anything can be brought back to Today.

## Triage

| Key | Action |
| --- | --- |
| `J` / `K` | next / previous item |
| `D` | done |
| `L` then `1`–`6` | later: in an hour, tonight 18:00, tomorrow 08:00, Monday 08:00, in a week, someday |
| `X` | dismiss |
| `R` | reply to Major (sends the note and marks the item done) |
| `U` | undo the last action |
| `1` `2` `3` | Today, Overview, Archive |
| `/` | search the archive |

Every action shows an Undo button in the toast. Quiet items can be dismissed all at once.

## How tasks are handled (v2)

- **A single ledger** (`data/ledger.json`) holds every item Major has sent, keyed by id, with its status (`open`, `later`, `done`, `dismissed`). Today, the queue and the archive all read from it. v1 kept items in three files and copied them between those files.
- **Later has a time.** A snoozed item comes back to Today on its own when that time arrives, even if Major's newer briefs no longer include it. In v1, Later was a list you had to go and look at.
- **Re-sent items are recognised.** If Major sends an item you already finished, it stays hidden. If its content changed, it comes back with a "Changed since you finished it" badge. Dismissed items stay hidden either way. Items that show up across several briefs get a "Day N" badge.
- **Instant saves, reliable delivery.** Actions are saved locally and the UI responds right away. Webhook posts go through an outbox (`data/outbox.json`) that retries with backoff for up to 12 attempts. After that they land in `failed-posts.jsonl`. v1 blocked each click for up to 8 s and dropped failures. The dot at the bottom of the side rail shows sync status. Click it to retry.
- **Live updates.** Open tabs refresh over server-sent events when Major posts a brief, when you act from another device, or when a snooze comes due.
- **Daily snapshots** (`data/briefs/<day>--<kind>.json`) and an event log (`data/events.jsonl`) back the archive and overview.

On first start, v1 data (`board.json`, `history.json`, `dismissed.json`) is migrated into the ledger automatically. The old files are left in place.

## API

Unchanged for Major:

- `POST /api/board` with `{ kind, date, items: [{ id, lane, title, body, image?, url?, note? }] }`. `lane` is `need-you`, `worth-knowing` or `quiet`.
- Webhook payload: `{ action, item_id, lane, title, note }`, with `Authorization: Bearer <key>` and `X-Automation-Key`. New: `later` includes `until` (ISO time), and there's a new `undo` action with `reverted`.

New for the UI: `GET /api/stats`, `GET /api/briefs`, `GET /api/briefs/:day`, `GET /api/search?q=&status=`, `GET /api/status`, `GET /api/stream`, `POST /api/bulk`, `POST /api/undo`, `POST /api/outbox/retry`. `/history` now opens the Archive view.

Environment overrides: `BRIEF_DATA` (data dir), `BRIEF_CONFIG` (config path), `PORT`, `BRIEF_TZ` (default `Europe/Zurich`).
