# VSL Player — Self-Hosted Vidalytics Replacement (Test Task)

## Context

We're paying Vidalytics $1000+/month for video sales letter (VSL) hosting. We want to replace it with a self-hosted setup:

- **Bunny.net Stream** for video delivery (~$35/month)
- A **custom HTML5 video player** that mimics the Vidalytics UX
- A **Cloudflare Worker + D1** backend for "% watched" analytics

This repo contains a working starting point: the player, a standalone test page, and a Cloudflare Worker scaffold. Your job is to **make it production-ready, set up the infrastructure, and verify it works across all our target browsers/devices.**

Cost target after migration: **~$35/month total**. Annual savings: ~$11k.

---

## What's Already Here

```
app/
  page.tsx                 # Landing page with link to /vsl-test
  vsl-test/
    page.tsx               # /vsl-test route (the test page you'll iterate on)
    VslTestPageContent.tsx # Test page content — replace TEST_VIDEO_URL and ANALYTICS_URL here
  layout.tsx, globals.css

components/
  VslPlayer.tsx            # The custom VSL player (~70% done, see "Acceptance criteria" below)

workers/vsl-analytics/
  worker.ts                # Cloudflare Worker — POST /api/view, GET /api/stats
  schema.sql               # D1 table schema
  wrangler.toml            # Worker config (database_id empty — fill in after creating D1)
```

```bash
npm install
npm run dev
# Open http://localhost:3000/vsl-test
```

The player loads a public HLS test stream (Big Buck Bunny). It works on desktop and Android Chrome. **iOS Safari may have rough edges** — that's the main thing to verify and fix.

---

## Player Requirements

### The Vidalytics-style UX (what you must build)

1. **Page loads → video starts immediately, muted, playing inline** at 9:16 aspect ratio inside the page (NOT fullscreen yet). The user sees motion right away — critical for VSL conversion.

2. **First tap anywhere on the video** → all of the following happen at once:
   - Video **restarts from 0:00** (so the user doesn't miss the intro they couldn't hear)
   - Video **unmutes**
   - Video goes into **pseudo-fullscreen** (see below)

3. **Second tap (anywhere on the video) while in fullscreen** → pause + exit fullscreen.

4. **Third tap** → resume from where paused (NOT restart) + re-enter fullscreen.

5. **Resume playback across sessions**: if the user closes the tab and comes back later, the muted inline preview should auto-resume from where they left off (via `localStorage`).

6. **Tab visibility**: if the user switches tabs while watching, the video pauses. When they come back, it resumes.

### Critical: Fullscreen must be "pseudo-fullscreen", NOT native

**This is the most important requirement and the most common mistake. Read carefully.**

The naive approach uses the browser fullscreen API (`element.requestFullscreen()`). On iOS Safari, this invokes the **native Apple video player**, which gives the user:
- A scrubbing/seek bar (defeats no-seek)
- Skip-forward / skip-backward buttons
- Playback speed control
- A visible duration (kills the "is this video short?" psychology)

We do NOT want any of that. We want full control over the UI.

**The correct approach (used by Vidalytics):**

Pseudo-fullscreen = a `position: fixed; top:0; left:0; right:0; bottom:0; width:100vw; height:100dvh; z-index:999999` overlay covering the whole viewport, with our custom controls layered on top. The `<video>` element stays inline (with `playsInline`, `webkit-playsinline`, and `x5-playsinline` attributes) and never invokes native fullscreen.

When entering pseudo-fullscreen, also lock body scroll (`position: fixed` on `body`) so the page behind doesn't scroll.

The current code does this — verify it works correctly on iPhone and fix it if not.

### No-seeking, no-controls

- **No native browser controls** (`controls` attr must NOT be present)
- **No seeking allowed** — neither via clicking a progress bar nor via keyboard arrows
- **No playback speed control**
- **No right-click context menu** on the video
- A view-only progress bar IS fine — it shows how far they've watched but isn't interactive

### Visible UI elements

| Element | When shown | Behavior |
|---------|-----------|----------|
| Big play button overlay (centered) | When autoplay was blocked by browser | Click → restart from 0:00, unmute, fullscreen |
| "Tap to unmute" banner (top) | While muted AND playing | Click → restart from 0:00 (first time only), unmute, fullscreen |
| Play/pause button (bottom-left) | While playing in fullscreen | Click → pause/resume + exit/enter fullscreen |
| View-only progress bar (bottom) | While playing | Auto-updates with `timeupdate` event, no pointer events |

### Compatibility

Must work correctly on:

- **iPhone Safari** (most important — most traffic)
- **Android Chrome**
- **Desktop Chrome, Safari, Firefox**
- **In-app browsers**: Instagram, Facebook, TikTok WebView (a lot of traffic comes from ads here — verify pseudo-fullscreen works, since these sometimes block real fullscreen)

### Video format

The source URL will be an **HLS stream** (`.m3u8`) hosted on Bunny.net. The player must:
- Use **native HLS** on Safari (it supports HLS out of the box)
- Use **HLS.js** library on Chrome / Firefox (already in `package.json`)
- Fall back to MP4 if the URL doesn't end in `.m3u8`

The aspect ratio is **9:16 (vertical)** — `padding-top: 177.78%` on the container.

---

## Analytics Requirements

### What we want to measure

The single metric the owner cares about: **average % watched** per video.

Bonus metrics that come for free if we're already collecting:
- Total view count per video
- Views per day
- Country breakdown (using Cloudflare's `CF-IPCountry` header — free, no third party)

We do **NOT** want:
- Heatmaps
- Per-viewer journeys
- Cookie-based viewer IDs
- Anything that needs a consent banner

### How analytics data flows

The player tracks **the maximum % of the video the viewer reached** during their session (via the `timeupdate` event). On page close (`pagehide` / `beforeunload`), it fires **one** `POST /api/view` to the Cloudflare Worker via `navigator.sendBeacon()`:

```json
{
  "video_id": "test-vsl",
  "percent_watched": 47,
  "duration": 180
}
```

`sendBeacon` is critical — it survives page close where `fetch()` would be cancelled. `keepalive: true` is a fallback for browsers without sendBeacon.

Also fire the event when the video ends (`ended` event) so completed views are captured even if the user stays on the page.

### Cloudflare Worker endpoints

Already implemented in `workers/vsl-analytics/worker.ts`. Two endpoints:

**`POST /api/view`** — anyone can call. Records a view. CORS-restricted to allowlisted origins. Stores: `video_id`, `percent_watched` (0–100), `duration`, `country` (from `CF-IPCountry`), `created_at`.

**`GET /api/stats?video_id=X&days=30&secret=...`** — protected by a shared secret. Returns:
- Overall: total views, avg %, min %, max % per video
- Daily breakdown (views + avg % per day)
- Country breakdown

The owner queries this manually via curl or Claude Code. Not exposed publicly.

### D1 database

Cloudflare's serverless SQLite. Schema in `workers/vsl-analytics/schema.sql`:

```sql
CREATE TABLE views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  percent_watched INTEGER NOT NULL,
  duration INTEGER NOT NULL DEFAULT 0,
  country TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_views_video_id ON views(video_id);
CREATE INDEX idx_views_created_at ON views(created_at);
```

Free tier limits (more than enough): 100k writes/day, 5M reads/day, 5GB storage.

---

## Infrastructure Setup (You Will Do This)

### 1. Bunny.net Stream

1. Create a Bunny.net account
2. Enable **Stream** (their video CDN product)
3. Create a Stream library — choose a region close to most viewers (EU recommended; most VSL traffic is Bulgaria, Romania, Hungary, Poland)
4. Upload a **test VSL video** (any 30–60 second vertical video will do — even one of the public test videos works)
5. Get the **HLS playback URL** for that video — looks like:
   `https://vz-XXXXXXXX-XXX.b-cdn.net/<video-uuid>/playlist.m3u8`
6. Paste that URL into `app/vsl-test/VslTestPageContent.tsx`, replacing `TEST_VIDEO_URL`

**Configuration recommendations:**
- Enable **token authentication** on the library (prevents hotlinking)
- Disable the default Bunny embed player — we only use the raw HLS stream
- Encoding: let Bunny auto-encode to multiple bitrates for adaptive streaming
- DRM is not needed

Hand the Bunny dashboard credentials to the owner when you're done so they can upload the real VSLs later.

### 2. Cloudflare Worker + D1

```bash
cd workers/vsl-analytics

# 1. Install wrangler (Cloudflare's CLI) globally
npm install -g wrangler

# 2. Authenticate
wrangler login

# 3. Create the D1 database
wrangler d1 create vsl-analytics
# This prints a database_id — copy it into wrangler.toml under [[d1_databases]].database_id

# 4. Apply the schema
wrangler d1 execute vsl-analytics --remote --file=schema.sql

# 5. Set the stats secret (used to protect GET /api/stats)
wrangler secret put STATS_SECRET
# When prompted, paste any long random string and SHARE IT WITH THE OWNER

# 6. Deploy
wrangler deploy
```

After deploy you'll get a Worker URL like `https://vsl-analytics.<your-subdomain>.workers.dev`.

7. Paste that URL into `app/vsl-test/VslTestPageContent.tsx`, replacing the empty `ANALYTICS_URL` constant.

8. Add any preview deployment URL to the `CORS_ORIGINS` array in `worker.ts` if you deploy a preview to Vercel/Netlify:
   ```js
   const CORS_ORIGINS = [
     "https://dr-fit.co",
     "https://www.dr-fit.co",
     "https://your-preview-url.vercel.app",
     "http://localhost:3000",
   ];
   ```
   Redeploy the Worker after editing.

### 3. Custom domain for the Worker (optional but recommended)

By default the Worker is at `<worker-name>.workers.dev`. For nicer URLs and to reduce ad-blocker false positives, point it at a subdomain like `analytics.dr-fit.co` (owner will help with DNS):

1. In Cloudflare dashboard → Workers & Pages → vsl-analytics → Triggers → Add custom domain
2. Add `analytics.dr-fit.co`
3. Update the player's `ANALYTICS_URL` to the new domain

---

## Acceptance Criteria — How "Done" Is Verified

Deploy the test page to a public URL (Vercel, Netlify, your own — your choice). Then verify ALL of the following:

### Functional

- [ ] Page loads → video starts playing **muted, inline** within ~1 second (no big loading spinner)
- [ ] "Tap to unmute" banner is visible while muted
- [ ] **iPhone Safari**: tap the video → it restarts from 0:00, unmutes, and enters **pseudo-fullscreen** (custom UI overlay, NOT the native iOS player with scrubbing controls)
- [ ] **iPhone Safari**: while in fullscreen, swiping or rotating does NOT show iOS native controls. There is NO seek bar, NO skip buttons, NO speed control visible.
- [ ] Tap again in fullscreen → video pauses + fullscreen exits + page scroll restored
- [ ] Tap again → video resumes (NOT restarts) + re-enters fullscreen
- [ ] Right-clicking the video does nothing
- [ ] Keyboard arrows do nothing
- [ ] Close the tab, reopen the page → video auto-resumes from approximately where you left off
- [ ] Switch to another browser tab while playing → video pauses. Switch back → it resumes.
- [ ] Repeat all of the above on **Android Chrome**
- [ ] Repeat on **desktop Chrome, Safari, Firefox**
- [ ] Test in **Instagram in-app browser** (send the URL to yourself via DM, open it from inside Instagram) — pseudo-fullscreen must still work

### Analytics

- [ ] Open the test page, watch ~30% of the video, close the tab
- [ ] Run: `curl 'https://<worker-url>/api/stats?secret=<SECRET>'`
- [ ] Response contains a `views` record for `video_id: "test-vsl"` with `percent_watched ≈ 30`
- [ ] Watch from a different country (or use a VPN) and check `country` is populated correctly
- [ ] CORS rejects requests from any non-allowlisted origin (test with curl from a random `Origin:` header)

### Performance

- [ ] First frame visible within 1.5s on a fast 4G connection
- [ ] Total JS added by the player (`VslPlayer.tsx` + HLS.js) is under **200 KB gzipped**. If HLS.js is too large, lazy-load it only when an HLS stream is requested on a non-Safari browser.

### Quality

- [ ] No console errors on any browser
- [ ] No layout shift when the video loads (the 9:16 container reserves space immediately)
- [ ] Body scroll is locked while in pseudo-fullscreen and restored to the original scroll position when exiting

---

## Deliverables

When the work is complete, send the owner:

1. **A public URL** where `/vsl-test` works and meets all the acceptance criteria above
2. **The Worker URL** (e.g., `https://vsl-analytics.<sub>.workers.dev` or the custom domain)
3. **The `STATS_SECRET`** (privately — not in a PR)
4. **Bunny.net account credentials** handed off to the owner
5. **A short demo video** (screen recording, ≤60s) of you using the player on an iPhone, demonstrating: muted autoplay, tap-to-fullscreen, pause-to-exit, resume on reopen
6. **A pull request** with any fixes or improvements you made. Owner will review and merge.

---

## Common Pitfalls (Read This Before You Start)

1. **Real fullscreen breaks the UX on iOS.** Do NOT use `element.requestFullscreen()` or `video.webkitEnterFullscreen()`. Both trigger Apple's native player. The pseudo-fullscreen (`position: fixed`) approach is the only one that works.

2. **`playsInline` is required.** Without it, iOS will try to take the video fullscreen on play. Set `playsInline`, `webkit-playsinline`, and `x5-playsinline` on the `<video>` element.

3. **Muted autoplay must really be muted at the moment of `.play()`.** Set `video.muted = true` BEFORE calling `.play()`, even if you've already set it via the JSX `muted` prop. React doesn't always apply muted before play() resolves.

4. **`sendBeacon` payload must be a `Blob` with the right content-type.** A plain string won't work cross-origin. Use `new Blob([JSON.stringify(payload)], { type: "application/json" })`.

5. **HLS.js is ~140 KB.** If bundle size becomes an issue, lazy-import it only when needed (Safari has native HLS and doesn't need it).

6. **In-app browsers (Instagram, FB) sometimes block `localStorage`.** Wrap all `localStorage` access in try/catch (the current code does this).

7. **The "restart from 0:00 on first engagement" is intentional.** Users miss the first few seconds while the muted preview plays. When they tap to unmute, they want to hear from the start. Do not "fix" this.

---

## Important Constraints

- **Don't add npm dependencies** beyond `hls.js` (already added) without asking the owner first
- **Don't commit secrets** — `STATS_SECRET` goes via `wrangler secret put`, never into the repo
- **No tracking SDKs** in the player. No Mixpanel, no GA, no third-party analytics — only our own Worker endpoint
- **No third-party video player libraries** (Video.js, Plyr, etc.). We want a small custom component we fully control. HLS.js is the only exception.

---

## Reference Material

- Bunny Stream docs: https://docs.bunny.net/docs/stream-getting-started
- Cloudflare Workers + D1: https://developers.cloudflare.com/d1/get-started/
- HLS.js: https://github.com/video-dev/hls.js
- HTML5 `<video>` element: https://developer.mozilla.org/en-US/docs/Web/HTML/Element/video

---

## Questions?

Reach the owner via the agreed communication channel. Don't make assumptions about scope — ask if anything in this brief is unclear.
