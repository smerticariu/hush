# Third-party components in Hush

Hush is distributed under the GNU GPL v3 (see `LICENSE`). The package includes
data and code from the following projects, under their own licenses:

| Component | Used for | License | Source |
|---|---|---|---|
| uBlock Origin (Raymond Hill and contributors) | scriptlets, redirect resources | GPL-3.0 | https://github.com/gorhill/uBlock |
| uBlock Origin filters (uAssets) | lists: filters, privacy, badware, unbreak, quick-fixes, annoyances | GPL-3.0 | https://github.com/uBlockOrigin/uAssets |
| EasyList, EasyPrivacy | ad and tracker lists | GPL-3.0 / CC BY-SA 3.0 | https://easylist.to |
| Fanboy Cookie Monster, Fanboy Annoyances | cookie banner and annoyance lists | GPL-3.0 / CC BY-SA 3.0 | https://easylist.to |
| Brave adblock-lists | Brave lists (specific, first-party, CNAME, cookie, unbreak), query-filter | MPL-2.0 | https://github.com/brave/adblock-lists |
| ROList (Menetz, maintained by Zoso) | ads on Romanian sites | CC BY 3.0 | https://zoso.ro/rolist/ |

The lists are converted automatically into `declarativeNetRequest` rules, CSS and
scriptlet tables; their content is not otherwise modified. Hush's own list
(`filters/hush.txt`) is GPL-3.0.
