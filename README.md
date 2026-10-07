# VentureDesk Reader

Telegram Mini App for reading VentureDesk briefs and deep dives: a dated library, a Kindle-style reader (font size, typeface, Paper/Sepia/Night themes), tap-a-sentence highlights, and read/rating tracking that feeds back into what the bot writes.

- `index.html` — the whole reader (static, served by GitHub Pages). It holds no content or keys; everything loads from the API after Telegram signs the request.
- `backend/venturedesk/` — copy of the Supabase Edge Function (`venturedesk`) that powers the bot and the reader API (`/api/*`, authenticated with Telegram `initData`).

Live: https://nnovikow-cell.github.io/venturedesk-reader/ (opens properly only from the bot's 📚 Library button).
