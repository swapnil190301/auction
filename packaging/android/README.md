# Android (Google Play) — Trusted Web Activity

This packages the live site as a **Trusted Web Activity (TWA)**: a thin native
Android app that shows your deployed site full-screen, no browser bar. This is
Google's own recommended path for shipping a PWA to Play, and it's what
[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) (Google's official
CLI) automates from the `twa-manifest.json` in this folder.

**You must deploy the site first** (see the main README's Render section) —
Bubblewrap needs a real, live HTTPS URL to point at.

## One-time setup (on your own machine, not this chat)

1. Install prerequisites: **Node.js 18+**, **JDK 17**, and **Android SDK
   command-line tools** (Bubblewrap can download the JDK + SDK for you the
   first time you run it, if you don't already have them).
2. Install Bubblewrap:
   ```
   npm install -g @bubblewrap/cli
   ```

## Build the app

1. Open `packaging/android/twa-manifest.json` and replace every
   `REPLACE_WITH_YOUR_DOMAIN.onrender.com` with your actual deployed domain
   (e.g. `cricket-auction-xyz.onrender.com`, or your custom domain if you add
   one in Render). Also double check `packageId` — this is your app's unique
   identifier on Play (reverse-domain style, e.g. `com.yourname.cricketauction`)
   and **cannot be changed after your first upload**.
2. From `packaging/android/`, run:
   ```
   bubblewrap init --manifest ./twa-manifest.json
   ```
   This pulls your site's manifest, generates the Android project, and — the
   first time only — asks you to create a signing key (`android.keystore`).
   **Back up that keystore file and its password somewhere safe.** If you lose
   it, you can never update this app on Play again under the same listing —
   you'd have to publish as a brand new app.
3. Build the release bundle:
   ```
   bubblewrap build
   ```
   This produces `app-release-bundle.aab` (upload this to Play) and prints the
   **SHA-256 certificate fingerprint** of your signing key.

## Verify domain ownership (Digital Asset Links)

Play won't show your TWA as a "trusted", chrome-less app unless your domain
proves it authorized that specific Android package. This repo already has the
file at `public/.well-known/assetlinks.json` — after your build, edit it:

```json
[{
  "relation": ["delegate_permission/common.handle_all_urls"],
  "target": {
    "namespace": "android_app",
    "package_name": "com.yourname.cricketauction",
    "sha256_cert_fingerprints": ["THE_FINGERPRINT_BUBBLEWRAP_PRINTED"]
  }
}]
```

Commit, push, and redeploy so it's live at
`https://yourdomain/.well-known/assetlinks.json` (the server already serves
`public/.well-known/` correctly — dotfile paths are explicitly allowed there,
see `server/index.js`). Confirm it loads in a browser before submitting —
Play/Chrome will otherwise fall back to showing browser UI instead of a true
full-screen app.

## Submit to Google Play

1. Create a [Google Play Console](https://play.google.com/console) account
   ($25 one-time fee).
2. Create a new app, fill in the store listing (title, short/full description
   — see `packaging/store-listing.md` in this repo for drafts), upload
   screenshots (phone size at minimum) and the icons already in
   `public/icons/`.
3. Complete the **Content rating** questionnaire and **Data safety** section —
   `packaging/store-listing.md` has drafted answers based on what this app
   actually collects (accounts, room PINs, no ads/tracking).
4. Add a **Privacy policy URL**: `https://yourdomain/privacy.html` (already
   built into the app).
5. Upload `app-release-bundle.aab` under Production (or Internal testing
   first, which is recommended) and submit for review.

## Updating the app later

Because a TWA just displays your live site, most changes (new features, bug
fixes) need **no new Android build at all** — deploy to Render and users see
it immediately, the same as any website. You only need to repeat the
Bubblewrap build/upload steps if you change the app's *native* wrapper
properties (icon, name, package ID, signing key) — not for ordinary app
changes.
