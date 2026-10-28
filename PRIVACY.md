# Hush privacy policy

*Last updated: October 28, 2026*

**In short: Hush does not collect, send or sell any information about you.**

- All blocking happens inside your browser. Hush has no server, makes no network
  requests of its own and contains no analytics or telemetry.
- The addresses of the pages you visit are used locally, while a page loads, to
  apply the right rules for that site.
- **Stats.** Hush counts what it blocks: totals per day, the sites where it blocked
  the most and the domains it blocked most often. These counts are stored in
  Chrome's local storage on this computer only, are never synced or sent anywhere,
  and can be erased at any time with "Reset stats" in the dashboard. Hush does not
  keep a history of the pages you visit.
- **Settings.** Your settings (enabled categories, paused sites, your own filters)
  are saved in Chrome's storage. If Chrome Sync is on, Chrome syncs them across
  your own computers through your Google account; Hush has no access to them
  outside your browser.

## Permissions

| Permission | Why |
|---|---|
| Access to all sites | so the rules apply on every page and ad elements can be hidden |
| declarativeNetRequest | blocking requests to ad and tracker domains, done by Chrome itself |
| webRequest | observing (not changing) which requests were blocked, to show the counts |
| scripting | injecting the CSS that hides ads and the scripts that neutralize video ads |
| storage | saving your settings and stats |
| contextMenus | the "Hide an element on this page" right-click option |

Questions: open an issue at https://github.com/smerticariu/hush
