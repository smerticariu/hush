# Hush

A Chrome extension (Manifest V3) that blocks ads, trackers, cookie banners and
dangerous sites. It uses the same community filter lists and techniques as
Brave Shields and uBlock Origin, built to fit the limits of a Chrome extension.

Free, open source, and it collects nothing.

## Install from source

1. `npm install`, then `git clone --depth 1 https://github.com/gorhill/uBlock vendor/uBlock`
2. `npm run update` (downloads the filter lists, builds `dist/` and validates the rules)
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick `dist/`

After refreshing the lists with `npm run update`, press ↻ on the extension's card.

## How it works

| What Brave does | What Hush does |
|---|---|
| Blocks requests in its network stack (adblock-rust) | The lists are compiled at build time into ~22,000 `declarativeNetRequest` rules that Chrome applies itself, with no extension code in the request path |
| Hides leftover elements (cosmetic filtering) | A content script asks for the host's CSS and injects it as a user stylesheet; class names and ids are looked up in the generic table as they appear |
| Procedural filters (`:has-text`, `:upward`…) | Its own engine in `content/cosmetic.js`, re-run on DOM changes |
| Scriptlets (YouTube, anti-adblock) | uBlock Origin's scriptlets, bundled at build time and run at `document_start` in the page's world, only on the hosts that need them |
| Harmless stand-ins for blocked scripts | DNR redirects to `redirects/` (Google Analytics, GPT, IMA…) |
| Strips tracking parameters from links | Brave's `query-filter.json` → `removeParams` rules |
| CNAME uncloaking | Not possible from an extension; partly covered by `brave-firstparty-cname.txt` |

Lists: EasyList, EasyPrivacy, uBlock Origin (filters, privacy, badware, unbreak,
quick-fixes), Brave's lists (specific, first-party, first-party CNAME, cookie,
unbreak), ROList and Hush's own `filters/hush.txt`. Cookie banner lists (EasyList
Cookie, uBO cookies) are on by default; Fanboy / uBO annoyances are opt-in.

**Stats.** `webRequest` is used read-only to count what the DNR rules blocked:
requests that fail with `ERR_BLOCKED_BY_CLIENT`, requests redirected to the
bundled stand-ins, and links stripped of tracking parameters. The counts stay in
`chrome.storage.local` on that computer.

**Settings sync.** Categories, paused sites and custom filters live in
`chrome.storage.sync`, split into 3,000-character chunks to fit Chrome's per-item
limit; past the ~100 KB total they fall back to local storage and the dashboard
says so.

## Commands

| Command | What it does |
|---|---|
| `npm run update` | Updates the uBO source, downloads the lists, rebuilds and validates |
| `npm run build` | Rebuilds `dist/` from the downloaded lists and validates the rules in Chrome |
| `npm test` | Load test + functional tests on a local page |
| `npm run test:youtube` | YouTube ads: player data and ad mode |
| `npm run test:tester` | Score on adblock-tester.com (Chrome / Hush / Brave) |
| `npm run bench` | Compares Chrome, Hush and Brave on real sites |
| `npm run pack` | The Chrome Web Store zip, in `release/` |
| `npm run store-shots` | Store screenshots and promo tile, in `store/` |

Tests use Chrome for Testing from Playwright's cache (branded Chrome no longer
accepts `--load-extension`; set `CHROME_PATH` to override) and Brave from
`/Applications` for comparisons.

## Layout

```
src/              extension code (copied into dist/ at build time)
  background.js     service worker: settings, rulesets, cosmetics, scriptlets, stats, messages
  content/          cosmetic.js (every page), picker.js (on demand)
  popup/ dashboard/ the UI
  shared/           filter parser (used at build time and in the extension), settings, stats
filters/hush.txt  Hush's own rules
tools/            build, list download, validation, tests, packaging, publishing
vendor/uBlock     uBlock Origin source (only read at build time, for scriptlets and resources)
```

## Known limits

- Network rules are static: new lists ship as new versions (automated, see `PUBLISHING.md`).
- No CNAME uncloaking and no HTML filtering (`##^`), as in any MV3 extension.
- On YouTube, a video can start a few seconds late: that's YouTube's penalty for blocking, same as with uBO.
- Custom filters support network and cosmetic rules, not scriptlets (`+js`).

## License

GPL-3.0. The uBlock Origin code and the filter lists keep their own licenses, see `NOTICES.md`.
