# Store listing drafts

Starting text for the Play Console and App Store Connect listing forms.
Edit freely — these are drafts, not final copy — and swap in real screenshots
once the app is deployed (a host console, a team bidding screen, and the
spectator view make good ones).

## App name / subtitle

- **Name:** Live Cricket Auction
- **Subtitle (iOS) / short description (Play, max 80 chars):** Run or join a live cricket player auction with friends

## Full description

```
Live Cricket Auction turns the "player auction" night of a local or friends'
cricket league into something everyone can follow from their own phone —
no spreadsheet, no shouting across the room to relay the current bid.

HOST AN AUCTION
Set up teams, starting purse, player tiers and base prices, then run the
auction from one screen: start/pause, accept bids, mark a player sold or
unsold, undo a mistake, or reset and start over. Pre-assign a team's owner,
captain, or icon player before the bidding even starts.

JOIN AS A TEAM
Each team gets its own PIN and its own bidding screen — showing exactly what
you can afford to bid without breaking your ability to fill your remaining
squad slots.

REGISTER TO BE AUCTIONED
Players can create a free profile once (name, age, playing role, optional
photo) and reuse it to register for any auction room with just a Room ID and
Player PIN — no re-typing your details every season.

WATCH LIVE
Anyone with the Room ID can follow along in real time on a shared screen or
projector, with no PIN required.

Everything updates live across every connected device the moment a bid comes
in. No ads, no account required just to watch.
```

## Keywords (iOS, comma-separated, ≤100 chars)

```
cricket,auction,ipl,fantasy,league,team,bidding,sports,tournament,draft
```

## Category

- Play: **Sports**
- App Store: **Sports** (secondary: Utilities)

## Content rating questionnaire

This app has no violence, sexual content, gambling-with-real-money, drugs, or
user-generated text chat between strangers. Bidding uses play-money "purse"
values set by the room host, not real currency or in-app purchases. Expected
outcome on both stores: **everyone / 4+**.

- Does the app include real-money gambling or contests? **No** — purses and
  bids are notional numbers the host defines; there is no real-money wagering,
  payment processing, or prize payout.
- Does the app allow user-generated content visible to others? Limited — a
  player's name/age/role/photo (which they chose to upload) and a room's
  team/player names are visible to others *in that specific room*, not
  publicly searchable or shared outside it.
- Does the app include ads or in-app purchases? **No.**

## Google Play — Data Safety section

**Does your app collect or share any of the required user data types?** Yes.

| Data type | Collected? | Shared with third parties? | Why |
|---|---|---|---|
| Name | Yes (player's display name) | No | Shown in the auction room the player joins |
| Email address | No | — | Accounts use a username, not an email |
| Photos | Optional (profile photo) | No | Shown alongside a player's name during the auction |
| Age | Yes | No | Sometimes relevant for junior/age-group auction categories |
| App activity (in-app actions, e.g. bids placed) | Yes | No | Needed for the auction itself to function |
| Precise/approximate location | No | — | Not requested or used |
| Device or other identifiers | No | — | Not requested or used |

- **Is all user data encrypted in transit?** Yes, when deployed over HTTPS
  (the default for Render and any standard host).
- **Do you provide a way for users to request data deletion?** Not
  self-service yet — state in the listing that users can contact the app's
  operator/support address to request deletion.
- **Data collected is used for:** App functionality only. Not for
  advertising, analytics profiling that leaves the app, or account
  personalization beyond what's described above.

## Apple App Store — App Privacy ("nutrition label")

- **Data Used to Track You:** None. This app performs no tracking (no ad
  networks, no cross-app/cross-site identifiers, no IDFA usage) — you can
  answer "No" to the App Tracking Transparency question, and no ATT prompt is
  needed.
- **Data Linked to You:**
  - *Contact Info* → Name (player's display name)
  - *User Content* → Photos (optional profile photo)
  - *Identifiers* → User ID (the account's internal ID / username)
- **Data Not Linked to You:** none beyond the above — no analytics data
  collected.
- **Data Not Collected:** Financial info, Location, Contacts, Browsing
  History, Health & Fitness, Sensitive Info.

## Support & marketing URLs

- **Support URL:** point this at wherever you want players/hosts to reach
  you (an email `mailto:` link works, or a simple contact page).
- **Marketing URL (optional):** your deployed site's root URL works fine.
- **Privacy Policy URL:** `https://yourdomain/privacy.html` (already built —
  see `public/privacy.html`).
