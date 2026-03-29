# Cricket Auction App

Live cricket auction with a **Node** server holding authoritative state and **WebSockets** pushing updates to every connected browser.

## How to run locally

1. Install dependencies: `npm install`
2. Start the server: `npm start`
3. Open **http://127.0.0.1:3000** (or the URL printed in the terminal). The server listens on all interfaces (`0.0.0.0`).

Opening `index.html` directly from disk (`file://`) will not work: the app needs the Node server for the REST API and WebSockets.

## Auctioneer vs team dashboards

- **Auctioneer (host)** — open `/` or `/?view=auctioneer`. Run the auction: start/pause, sold, unsold, skip, undo, reset. Teams place bids from their own links; the host screen updates in real time (bid log and state).
- **Team** — each franchise opens a dedicated link, for example:  
  `/?view=team&teamId=team-1`  
  Use the same `teamId` values as in the auction state (e.g. `team-1` … `team-6`). Optional `room` query isolates rooms: `?room=myroom&view=team&teamId=team-1`.

## Deploy on Render

1. Create a **Web Service** from this repo (or use the included [`render.yaml`](render.yaml) as a Blueprint).
2. **Build command:** `npm install`  
   **Start command:** `npm start`
3. Set **Health check path** to `/health` (optional).
4. Render sets `PORT` and `RENDER_EXTERNAL_URL` automatically; the server binds `0.0.0.0` and logs the public URL when `RENDER_EXTERNAL_URL` is present.

**WebSockets** are supported on Render web services; the client uses the same host for `wss://` as the page.

**Persistence:** the server writes [`data/auction-snapshot.json`](data/auction-snapshot.json). On Render, the filesystem is **ephemeral** — data can survive restarts on the same instance but may be **lost on redeploy** unless you attach a [Render Disk](https://render.com/docs/disks) or use external storage.

**Cold starts:** free tier instances can sleep; for a live auction event, consider a paid always-on instance.

## Port

Set the `PORT` environment variable if you need a port other than the default `3000` (local); Render injects `PORT` for you.

## Notes

- The app may load helpers from a public CDN where applicable.
- Photo uploads store base64 images in shared server state; keep images reasonably small for performance.

## Security note

Anyone with a team link can submit bids for that `teamId`. Treat team URLs as **capability links**; use unguessable room names and team IDs if you need basic obscurity.
