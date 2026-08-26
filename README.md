# Cricket Auction App

Live, multi-room cricket auction. A **Node** server holds authoritative state per room and **WebSockets** push updates to every connected device. Anyone with a **Room ID + PIN** can join from their own phone or laptop.

## How to run locally

1. Install dependencies: `npm install`
2. Start the server: `npm start`
3. Open **http://127.0.0.1:3000** (or the URL printed in the terminal). The server listens on all interfaces (`0.0.0.0`), so other devices on the same network can reach it via your machine's LAN IP.

Opening `index.html` directly from disk (`file://`) will not work: the app needs the Node server for the REST API and WebSockets.

## Installing it as an app (PWA)

The app is an installable Progressive Web App — no app store, no separate mobile build. Once it's reachable over **HTTPS** (a plain `http://` LAN address won't offer this; see Deploy below):

- **Android / desktop Chrome or Edge:** an "Install" icon appears in the address bar, or use the browser menu → "Install Cricket Auction" / "Add to Home screen". It opens in its own window with no browser chrome, using the icon and colors from [`public/manifest.json`](public/manifest.json).
- **iPhone / iPad (Safari):** Share → "Add to Home Screen".

The install prompt is powered by [`public/manifest.json`](public/manifest.json) and [`public/sw.js`](public/sw.js). The service worker only caches the static app shell (HTML/CSS/JS/icons) for a faster reload and to survive a brief connection drop — it deliberately never caches anything under `/api/` or the `/ws` WebSocket, since an auction is only ever meaningful live.

## How it works

Nothing about a room (teams, players, purse, PINs) is hardcoded in the app — every room is created from scratch through the UI:

1. **Create a room** — from the landing page, set a room name, teams, purse/tier pricing, and a player list (paste/upload a CSV, a quick one-name-per-line list, or leave it to self-registration below). Submitting gets you a **Room ID**, a **Host PIN**, one **PIN per team**, and a **Player PIN**.
2. **Share access** — give the Host PIN to whoever is running the auction, each team's PIN to that franchise, and the Player PIN to anyone who wants to put themselves up for auction. Anyone with just the Room ID can open a read-only spectator view — no PIN needed.
3. **Join a room** — from the landing page, enter the Room ID and a PIN. The PIN determines your role:
   - **Host PIN** → auctioneer console: start/pause, sell, mark unsold, skip, undo, reset, a "Room settings" panel to change squad size, purse, tier base prices/increments, and per-team name/purse after creation, a "Manage players" panel to reorder the queue, fix a player's role/tier/base price, and pre-assign an owner/captain/icon to a team before the auction starts, and a "Share room" panel to re-display or regenerate PINs, toggle player self-registration, and approve/reject registrations at any time.
   - **Team PIN** → that team's bidding console. A team can only ever bid as itself — the server enforces this from the PIN-derived session, not from anything in the URL.
   - **Player PIN** → not a login for a console; it lets a logged-in player account submit its profile into the room's pool (see below). Anyone can also open the registration link directly from a Player PIN without going through the generic Join screen.
   - **No PIN** → spectator dashboard (read-only), good for a shared screen or projector.
4. Every screen for a given room — host, each team, every spectator, every registered player's own status page — updates live over WebSockets as bids happen.

Regenerating a PIN from the host console immediately signs out anyone still using the old one.

## Player self-registration

Instead of (or alongside) a CSV, players can register themselves:

1. A player creates a lightweight account once (username, password, name, age, playing role, optional photo) from "Register to be auctioned" on the landing page. This profile is reused for every future room they join, on any device, by logging back in.
2. They enter a room's **Room ID + Player PIN**. Their saved profile is copied into that room's pool — never anything auction-specific.
3. Depending on the room's registration mode (set at creation, changeable anytime from the host's "Share room" panel):
   - **Hold for my approval** (default) — the registration waits in a "Pending player registrations" list; the host picks a tier (which sets base price) and approves or rejects it.
   - **Add them straight to the queue** — the player is added immediately at the lowest tier; the host can still adjust or remove them like any other player.
4. The player's own dashboard (`?roomId=...&screen=player`) shows their live status — pending, queued, currently on the block, or the final sold/unsold result — without needing to know anything about running the auction.

Auction-specific values (tier, base price, sale price, final team) are always set by the host, never by the player.

## Deploy on Render

1. Create a **Web Service** from this repo (or use the included [`render.yaml`](render.yaml) as a Blueprint).
2. **Build command:** `npm install`
   **Start command:** `npm start`
3. Set **Health check path** to `/health` (optional).
4. Render sets `PORT` and `RENDER_EXTERNAL_URL` automatically; the server binds `0.0.0.0` and logs the public URL when `RENDER_EXTERNAL_URL` is present.

**WebSockets** are supported on Render web services; the client uses the same host for `wss://` as the page.

**Persistence:** rooms and player accounts live in a SQLite database at `data/app.db`, written via Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) (no extra dependency, no native module to compile or download a prebuilt binary for — one less thing that can fail to install on a locked-down build host). Every action upserts just the one room that changed instead of rewriting a whole snapshot file, so a crash mid-write can't corrupt unrelated rooms. `data/app.db` (plus its `-wal`/`-shm` sidecar files) holds every room's teams, players, bid history, and **PINs** in plaintext, and `data/accounts.json`'s replacement holds player usernames and scrypt-hashed passwords — both are `.gitignore`d. On Render, the filesystem is **ephemeral** — data survives restarts on the same instance but is **lost on redeploy** unless you attach a [Render Disk](https://render.com/docs/disks) mounted at `data/` or move to external storage.

If you're upgrading from an older install that used `data/auction-snapshot.json` / `data/accounts.json`, the server imports them into `data/app.db` automatically the first time it starts — a one-time migration, logged to the console — after which those files are no longer read.

This app requires **Node 22.5+** (pinned via `.node-version` / the `engines` field in `package.json`) for `node:sqlite`; you'll see a one-line "SQLite is an experimental feature" warning on boot, which is expected and harmless — the handful of APIs this app uses (`exec`/`prepare`/`run`/`get`/`all`) have been stable since the module landed.

**Cold starts:** free tier instances can sleep; for a live auction event, consider a paid always-on instance.

## Player CSV format

Columns: `name,role,tier,team[,wallet]`. `role` is `Batter` / `Bowler` / `All-rounder` for auction players, or `Owner` / `Captain` / `Icon` for a squad member pre-assigned to a team before the auction starts (their purse deduction is configurable in "Advanced" on the create-room form). `team` for those roles is the team's letter (A, B, C…) or its exact name.

## Port

Set the `PORT` environment variable if you need a port other than the default `3000` (local); Render injects `PORT` for you.

## Notes

- Player photos: drop image files into `images/`, named to match player names (see `server/playerImages.js` for the matching rules); `server/renameImagesToPlayerNames.js` is a one-off helper that renames files to match a CSV's player names.
- A room's original CSV/list + settings are stored with the room so "Reset auction" rebuilds the exact same starting position without re-uploading anything.

## Security note

Session tokens are signed with a per-install secret (`data/.session-secret`, generated on first run, gitignored) and carry a PIN version — regenerating a PIN invalidates every token issued against the old one. PINs themselves are short and meant for a trusted group (like a friends' league), not for defending against a determined attacker; keep Room IDs and PINs out of public channels if you'd rather strangers not wander in.

Player accounts (in the `accounts` table of `data/app.db`) store a username, a salted/hashed password (scrypt — never the password itself), and the player's profile including their photo if they uploaded one. They share the same database file as rooms but a separate table; treat `data/app.db` as sensitive for the same reason (player names/photos, room PINs), even though passwords in it are hashed.
