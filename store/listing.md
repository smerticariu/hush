# Chrome Web Store listing

Copy into the Developer Dashboard. Primary language: English.

## Name
Hush — Ad & Tracker Blocker

## Summary (max 132 characters)
Blocks ads, trackers, cookie banners and dangerous sites. Free and open source. Collects nothing.

## Description
Hush blocks ads and trackers right inside Chrome, before they load.

• Ads: banners, pop-ups, video ads and sponsored widgets
• Trackers: analytics, tracking pixels and tracking parameters in links (fbclid, gclid, utm…)
• Cookie banners hidden automatically
• Protection from scam, malware and crypto-mining sites
• Pause Hush on any site with one click from the toolbar
• "Hide an element": point at anything that annoys you and it's gone
• Your stats: what was blocked today, this month and on each site, plus time and data saved
• Your own filters, in uBlock Origin / Adblock Plus syntax
• Settings sync across your computers through Chrome Sync

Hush uses well-known community filter lists (EasyList, EasyPrivacy, the uBlock
Origin lists, Brave's public lists, ROList) plus its own fixes, refreshed every
few days. Blocking is done by Chrome itself (declarativeNetRequest), so pages get
faster, not slower.

Hush collects nothing: no server, no analytics, no ads of its own. Stats stay on
your computer. The source code is public under the GPL-3.0 license.

## Category
Privacy & Security

## Single purpose
Blocking ads and trackers on web pages.

## Permission justifications
- **declarativeNetRequest**: blocks requests to ad and tracker domains using the filter lists bundled with the extension.
- **webRequest**: observes (without modifying) which requests were blocked, to show the blocked counts in the popup and dashboard. Counts are stored locally only.
- **scripting**: injects the CSS that hides ad elements and the scripts that neutralize video ads and adblock detectors.
- **storage**: saves the user's settings (enabled categories, paused sites, custom filters) and local stats.
- **contextMenus**: the "Hide an element on this page" right-click option.
- **Host permission (all sites)**: ads and trackers appear on any site; the filters have to apply on every page.
- **Remote code**: No. All code is in the package; the filter lists are data, updated through new extension versions.

## Data practices (Privacy form)
No data categories are collected. Tick the three certifications: not sold, not
used for purposes unrelated to the single purpose, not used for creditworthiness.

Privacy policy URL: https://github.com/smerticariu/hush/blob/main/PRIVACY.md

## Images
- Icon: `src/icons/128.png`
- Screenshots 1280×800: `store/screenshot-1.png`, `screenshot-2.png`, `screenshot-3.png`
- Promo tile 440×280: `store/promo-440x280.png`
(regenerate with `npm run store-shots`)
