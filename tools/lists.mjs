// Filter lists used at build time. `group` decides which DNR ruleset the
// network rules go to; cosmetic rules and scriptlets carry the same group so
// they can be turned off with it from the settings.

export const LISTS = [
  { id: 'easylist', group: 'ads', url: 'https://easylist.to/easylist/easylist.txt' },
  { id: 'ubo-filters', group: 'ads', url: 'https://ublockorigin.github.io/uAssets/filters/filters.txt' },
  { id: 'ubo-quick-fixes', group: 'ads', url: 'https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt' },
  { id: 'hush', group: 'ads', file: 'filters/hush.txt' },
  { id: 'rolist', group: 'ads', url: 'https://www.zoso.ro/pages/rolist.txt' },
  { id: 'brave-specific', group: 'ads', url: 'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-specific.txt' },
  { id: 'brave-firstparty', group: 'ads', url: 'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-firstparty.txt' },
  { id: 'easyprivacy', group: 'privacy', url: 'https://easylist.to/easylist/easyprivacy.txt' },
  { id: 'ubo-privacy', group: 'privacy', url: 'https://ublockorigin.github.io/uAssets/filters/privacy.txt' },
  { id: 'brave-firstparty-cname', group: 'privacy', url: 'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-firstparty-cname.txt' },
  { id: 'ubo-badware', group: 'badware', url: 'https://ublockorigin.github.io/uAssets/filters/badware.txt' },
  { id: 'ubo-unbreak', group: 'unbreak', url: 'https://ublockorigin.github.io/uAssets/filters/unbreak.txt' },
  { id: 'brave-unbreak', group: 'unbreak', url: 'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-unbreak.txt' },
  { id: 'easylist-cookie', group: 'cookies', url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt' },
  { id: 'brave-cookie-specific', group: 'cookies', url: 'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/brave-cookie-specific.txt' },
  { id: 'ubo-cookies', group: 'cookies', url: 'https://ublockorigin.github.io/uAssets/filters/annoyances-cookies.txt' },
  { id: 'easylist-annoyances', group: 'annoyances', url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt' },
  { id: 'ubo-annoyances', group: 'annoyances', url: 'https://ublockorigin.github.io/uAssets/filters/annoyances-others.txt' },
];

// Tracking parameters stripped from links, in Brave's format (query-filter.json).
export const QUERY_FILTER = 'https://raw.githubusercontent.com/brave/adblock-lists/master/brave-lists/query-filter.json';

// The groups, in the order shown in the settings. `defaultOn` = enabled at install.
export const GROUPS = [
  { id: 'ads', name: 'Ads', description: 'Banners, pop-ups, video ads and sponsored widgets', defaultOn: true },
  { id: 'privacy', name: 'Trackers', description: 'Analytics, tracking pixels, fingerprinting and tracking parameters in links', defaultOn: true },
  { id: 'badware', name: 'Dangerous sites', description: 'Scams, malware, phishing and crypto miners', defaultOn: true },
  { id: 'unbreak', name: 'Site fixes', description: 'Always on: exceptions that repair sites broken by the other lists', defaultOn: true, locked: true },
  { id: 'cookies', name: 'Cookie banners', description: 'Hides cookie consent pop-ups', defaultOn: true },
  { id: 'annoyances', name: 'Other annoyances', description: 'Newsletter pop-ups, chat bubbles, "use our app" banners', defaultOn: false },
];
