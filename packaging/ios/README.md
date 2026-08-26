# iOS (App Store) — Capacitor wrapper

Apple has no equivalent of Android's Trusted Web Activity — there is no
Apple-blessed "just show my PWA" app type. [Capacitor](https://capacitorjs.com/)
is the standard way to wrap a web app for iOS; this folder has a starting
config for it (`capacitor.config.json`), pointed at your deployed site via
`server.url` instead of bundling files locally, so — like the Android TWA —
most updates need no new iOS build at all.

**Read the risk section below before spending the $99/year** — this is the
one part of "deploy to both stores" that can't be fully de-risked in advance.

## Prerequisites (all on your own machine — none of this runs here)

- A **Mac** running a recent macOS, with **Xcode** installed from the App
  Store. There is no way around this for iOS — Apple requires builds to be
  signed and uploaded from Xcode (or `xcodebuild`) on macOS.
- An **Apple Developer Program** account — $99/year, enrolled at
  [developer.apple.com](https://developer.apple.com/programs/).
- Node.js 18+ and [CocoaPods](https://cocoapods.org/) (`sudo gem install cocoapods`).

## Build the wrapper

From the repo root, on your Mac:

```
npm install @capacitor/core @capacitor/ios
npm install -D @capacitor/cli
npx cap init "Cricket Auction" com.swapnil.cricketauction --web-dir=www
```

Then copy the settings from `packaging/ios/capacitor.config.json` into the
`capacitor.config.json` that `cap init` created at the repo root (update the
`server.url` to your real deployed domain first), and add the iOS platform:

```
mkdir -p www && echo "placeholder" > www/index.html   # required even though server.url takes over at runtime
npx cap add ios
npx cap sync ios
npx cap open ios
```

That last command opens the generated `ios/App/App.xcworkspace` in Xcode. From
there: set your Team (Signing & Capabilities tab) to your Apple Developer
account, pick a real device or simulator to test on, and confirm the app
launches and loads your live site full-screen.

## The actual risk: App Store Review Guideline 4.2.6

Apple's review guidelines explicitly target "template" or "wrapper" apps:

> Apps that are simply web sites bundled as apps do not belong on the App
> Store... Your app should include features, content, and UI that elevate it
> beyond a repackaged website.

A pure Capacitor wrapper around this app is exactly the shape Apple is
describing, so **rejection on first submission is a real possibility**, not a
hypothetical. Things that measurably help:

- Add at least one native-feeling capability via a Capacitor plugin —
  `@capacitor/push-notifications` (e.g. notify a team when they're outbid),
  `@capacitor/haptics` (tap feedback on bid buttons), or `@capacitor/share`
  (native share sheet for a room's invite link) are all realistic fits for
  this specific app and aren't large lifts. None of these are built yet —
  they're the next step if you want to reduce rejection risk before
  submitting.
- Use a proper native app icon and launch screen (already have the icon
  assets in `public/icons/`; Xcode's asset catalog needs its own icon set
  generated from `icon-512.png` — Xcode can do this for you, or use
  [appicon.co](https://appicon.co)).
- In your App Store Connect listing, write the description around what a host
  or team actually *does* in the app (run/join a live auction), not "a web
  view of our website."

If it's rejected, Apple tells you exactly which guideline and gives you a
chance to respond or resubmit — it's not a one-shot process.

## Submit to the App Store

1. In Xcode: **Product → Archive**, then **Distribute App → App Store
   Connect**.
2. In [App Store Connect](https://appstoreconnect.apple.com/): create the app
   record, fill in the listing (see `packaging/store-listing.md` for drafts),
   upload screenshots for the device sizes Apple requires, fill in the
   **App Privacy** section (also drafted in `store-listing.md`), and set the
   **Privacy Policy URL** to `https://yourdomain/privacy.html`.
3. Select your uploaded build and submit for review. Consider running it
   through **TestFlight** first (free, same Developer account) to catch
   issues before a formal review.
