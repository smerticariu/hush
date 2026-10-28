# Publishing to the Chrome Web Store (Unlisted)

Hush is published as "Unlisted": it doesn't show up in search, but anyone with
the link can install it, and it syncs to every computer signed into the same
Chrome profile.

## 1. Developer account (once)

1. https://chrome.google.com/webstore/devconsole → one-time 5 USD fee
2. Verify the publisher account's email

## 2. First version, by hand

1. `npm run update && npm run pack` → `release/hush-<version>.zip`
2. Dashboard → **New item** → upload the zip
3. Fill in from `store/listing.md`: description, category, images, permission
   justifications, data practices, privacy policy URL
4. **Distribution → Visibility: Unlisted**
5. **Submit for review**. The first review usually takes a few days
   (extensions with access to all sites get a closer look)
6. Note the **Item ID** (in the page URL) and the **Publisher ID** (Account page)

## 3. Credentials for automatic updates (once)

1. https://console.cloud.google.com → new project → enable the **Chrome Web Store API**
2. **OAuth consent screen**: External, add yourself as a test user
3. **Credentials → Create OAuth client ID → Desktop app** → Client ID + Client secret
4. Refresh token, from https://developers.google.com/oauthplayground :
   ⚙ → "Use your own OAuth credentials" (the Client ID / secret above) →
   scope `https://www.googleapis.com/auth/chromewebstore` → Authorize →
   "Exchange authorization code for tokens" → copy `refresh_token`
5. In the repo: **Settings → Secrets and variables → Actions**, add
   `CWS_PUBLISHER_ID`, `CWS_EXTENSION_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`

Note: while the OAuth app is in "Testing" mode, Google revokes the refresh token
after 7 days. Switch the consent screen to **In production** (no verification
needed for personal use) so the token keeps working.

## 4. Updates

`.github/workflows/release.yml` runs every 3 days (and on demand from the Actions
tab): it downloads the lists and the uBO source, builds, validates the rules in
Chromium, runs the tests, then uploads and publishes. Every version goes through
Google's review (usually hours, sometimes days). If a test fails, nothing is published.
Until the secrets exist, the publish step fails and the zip is still attached to the run.

By hand, from a Mac: `npm run update && npm test && npm run pack`, then
`node tools/publish.mjs release/hush-<version>.zip` with the `CWS_*` variables set.

## Moving from the unpacked build

The store version has a different ID than the one loaded with "Load unpacked",
and storage (including synced storage) belongs to the ID. So, once: copy the text
from "My filters" and the paused sites from the old one, install the store
version, paste them there, then remove the old one from `chrome://extensions`.
From then on, the store version syncs them across your computers by itself.
