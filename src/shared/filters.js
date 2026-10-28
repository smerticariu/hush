// Parser for uBO / ABP filter syntax and conversion to declarativeNetRequest
// rules. No dependencies: runs at build time (node) and in the service worker
// (for user-written filters).

export const PRIORITY = {
  block: 10,
  redirect: 20,     // beats a plain block on the same request
  removeparam: 20,
  csp: 10,
  allow: 30,        // @@ exceptions beat block and redirect
  importantBlock: 40,
  importantRedirect: 50,
  userAllow: 100,   // site disabled by the user: beats everything
};

// Variables for `!#if`. We present ourselves as uBO Lite on Chromium: same
// limits (no html filtering, no CNAME), so the same branches of the lists.
const ENV = {
  env_chromium: true, env_mv3: true, ext_ubol: true, ext_ublock: true,
  cap_user_stylesheet: true, env_firefox: false, env_safari: false,
  env_mobile: false, env_edge: false, cap_html_filtering: false,
  cap_ipaddress: false, adguard: false, adguard_ext_chromium: false,
  false: false, true: true,
};

function evalCondition(expr) {
  // !#if accepts !, &&, || and parentheses
  const js = expr.replace(/[a-z_][a-z0-9_]*/gi, (name) => (ENV[name] ? 'true' : 'false'));
  if (!/^[truefals!&|() ]*$/.test(js)) return false;
  try { return Function(`return (${js});`)(); } catch { return false; }
}

// Applies the !#if / !#else / !#endif directives. Returns the remaining lines.
export function preprocess(text) {
  const out = [];
  const stack = []; // each level: { active, parentActive }
  let active = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('!#if')) {
      stack.push({ active, cond: evalCondition(line.slice(4).trim()) });
      active = active && stack[stack.length - 1].cond;
      continue;
    }
    if (line.startsWith('!#else')) {
      const top = stack[stack.length - 1];
      if (top) active = top.active && !top.cond;
      continue;
    }
    if (line.startsWith('!#endif')) {
      const top = stack.pop();
      active = top ? top.active : true;
      continue;
    }
    if (active) out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------- hostnames

const HOST_RE = /^[a-z0-9.-]+$/;

export function toAsciiHost(host) {
  host = host.toLowerCase();
  if (HOST_RE.test(host)) return host;
  try {
    const h = new URL(`http://${host}/`).hostname;
    return HOST_RE.test(h) ? h : null;
  } catch { return null; }
}

// "a.com|~b.com" or "a.com,~b.com" -> { include: [...], exclude: [...], entities }
function parseDomainList(list, sep) {
  const include = [], exclude = [], includeEntities = [], excludeEntities = [];
  for (let d of list.split(sep)) {
    d = d.trim();
    if (!d) continue;
    const neg = d.startsWith('~');
    if (neg) d = d.slice(1);
    if (d.endsWith('.*')) {
      (neg ? excludeEntities : includeEntities).push(d.toLowerCase());
      continue;
    }
    // regex in domain= (uBO) — can't be expressed in DNR
    if (d.startsWith('/')) return null;
    const h = toAsciiHost(d);
    if (!h) continue;
    (neg ? exclude : include).push(h);
  }
  return { include, exclude, includeEntities, excludeEntities };
}

// ------------------------------------------------------------ classification

// Cosmetic separators, in the order they must be tried.
const COSMETIC_SEPARATORS = ['#@?#', '#@$#', '#@%#', '#?#', '#$#', '#%#', '#@#', '##'];

/**
 * Classifies a line. Returns:
 *  null                                       comment / empty / unsupported
 *  { kind: 'network', text }
 *  { kind: 'cosmetic', domains, exception, body, sep }
 */
export function classify(line) {
  if (!line || line.startsWith('!') || line.startsWith('[')) return null;
  if (line.startsWith('# ') || line === '#') return null;

  // hosts: "0.0.0.0 domain"
  const hosts = line.match(/^(?:0\.0\.0\.0|127\.0\.0\.1|::1?)\s+([^\s#]+)/);
  if (hosts) {
    if (hosts[1] === 'localhost' || hosts[1] === '0.0.0.0') return null;
    return { kind: 'network', text: `||${hosts[1]}^` };
  }

  // HTML filtering (##^ and $$) doesn't exist in MV3
  if (/^[^\s/|^]*\$@?\$/.test(line)) return null;

  const hash = line.indexOf('#');
  if (hash !== -1) {
    const prefix = line.slice(0, hash);
    if (/^[a-z0-9.*,~_[\]:-]*$/i.test(prefix) || /^[^/|^$]*$/.test(prefix) && !prefix.includes('/')) {
      for (const sep of COSMETIC_SEPARATORS) {
        if (line.startsWith(sep, hash)) {
          const body = line.slice(hash + sep.length).trim();
          if (!body) return null;
          return {
            kind: 'cosmetic',
            domains: prefix,
            exception: sep.includes('@'),
            sep: sep.replace('@', ''),
            body,
          };
        }
      }
    }
  }
  return { kind: 'network', text: line };
}

// ------------------------------------------------------------ network

const TYPE_MAP = {
  script: ['script'],
  image: ['image'], img: ['image'],
  stylesheet: ['stylesheet'], css: ['stylesheet'],
  xmlhttprequest: ['xmlhttprequest'], xhr: ['xmlhttprequest'],
  subdocument: ['sub_frame'], frame: ['sub_frame'],
  object: ['object'], 'object-subrequest': ['object'],
  media: ['media'],
  font: ['font'],
  websocket: ['websocket'],
  ping: ['ping'], beacon: ['ping'],
  other: ['other', 'csp_report', 'webbundle', 'webtransport'],
  webtransport: ['webtransport'],
  document: ['main_frame', 'sub_frame'], doc: ['main_frame', 'sub_frame'],
};
const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'];

// Options we ignore without losing the filter.
const IGNORED_OPTIONS = new Set(['collapse', 'genericblock', 'cname', 'stealth', 'xhtml', 'network']);
// Options that make the filter impossible in DNR: we skip it.
const UNSUPPORTED_OPTIONS = new Set(['popup', 'popunder', 'header', 'permissions', 'uritransform',
  'urlskip', 'replace', 'ipaddress', 'webrtc', 'sitekey', 'jsonprune', 'hls', 'cookie', 'extension',
  'app', 'urltransform', 'responseheader', 'inline-font', 'inline-script', 'reason', 'content']);
const COSMETIC_EXCEPTION_OPTIONS = {
  elemhide: 'elemhide', ehide: 'elemhide',
  generichide: 'generichide', ghide: 'generichide',
  specifichide: 'specifichide', shide: 'specifichide',
};

function splitOptions(s) {
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { cur += c + s[++i]; continue; }
    if (c === ',') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

// Finds the '$' that separates the options (the last one followed by valid options).
function findOptionsStart(text) {
  let i = text.length;
  while ((i = text.lastIndexOf('$', i - 1)) > -1) {
    const tail = text.slice(i + 1);
    if (/^~?[a-z0-9_-]+(=|,|$)/i.test(tail)) {
      return i;
    }
    if (i === 0) break;
  }
  return -1;
}

/**
 * Parses a network filter. Returns null if unsupported, otherwise an intermediate
 * object (no id) that can be turned into a DNR rule.
 */
export function parseNetwork(text, ctx = {}) {
  let s = text;
  const exception = s.startsWith('@@');
  if (exception) s = s.slice(2);

  let optsText = '';
  const optIdx = findOptionsStart(s);
  if (optIdx !== -1) { optsText = s.slice(optIdx + 1); s = s.slice(0, optIdx); }

  const f = {
    exception, pattern: s, important: false, matchCase: false, badfilter: false,
    types: null, excludedTypes: [], domainType: null,
    initiator: null, request: null, denyallow: [],
    redirect: null, removeparam: null, csp: null, cosmeticException: null, methods: null,
    excludedMethods: null,
  };

  if (optsText) {
    for (let opt of splitOptions(optsText)) {
      opt = opt.trim();
      if (!opt) continue;
      const neg = opt.startsWith('~');
      const eq = opt.indexOf('=');
      let name = (eq === -1 ? opt : opt.slice(0, eq)).replace(/^~/, '').toLowerCase();
      const value = eq === -1 ? '' : opt.slice(eq + 1);
      if (name === '_' || /^_+$/.test(name)) continue;
      if (IGNORED_OPTIONS.has(name)) continue;
      if (UNSUPPORTED_OPTIONS.has(name)) return null;
      if (COSMETIC_EXCEPTION_OPTIONS[name]) { f.cosmeticException = COSMETIC_EXCEPTION_OPTIONS[name]; continue; }
      if (TYPE_MAP[name]) {
        if (neg) f.excludedTypes.push(...TYPE_MAP[name]);
        else (f.types ??= []).push(...(name === 'document' || name === 'doc' ? (exception ? ['main_frame', 'sub_frame'] : ['main_frame']) : TYPE_MAP[name]));
        if ((name === 'document' || name === 'doc') && exception && !neg) f.documentException = true;
        continue;
      }
      switch (name) {
        case 'all': (f.types ??= []).push(...ALL_TYPES); break;
        case 'third-party': case '3p': f.domainType = neg ? 'firstParty' : 'thirdParty'; break;
        case 'first-party': case '1p': f.domainType = neg ? 'thirdParty' : 'firstParty'; break;
        case 'strict3p': f.domainType = 'thirdParty'; break;
        case 'strict1p': f.domainType = 'firstParty'; break;
        case 'important': f.important = true; break;
        case 'match-case': f.matchCase = true; break;
        case 'badfilter': f.badfilter = true; break;
        case 'domain': case 'from': {
          const d = parseDomainList(value, '|');
          if (!d) return null;
          f.initiator = d; break;
        }
        case 'to': {
          const d = parseDomainList(value, '|');
          if (!d) return null;
          f.request = d; break;
        }
        case 'denyallow': {
          const d = parseDomainList(value, '|');
          if (!d) return null;
          f.denyallow = d.include; break;
        }
        case 'method': {
          for (const m of value.toLowerCase().split('|')) {
            if (m.startsWith('~')) (f.excludedMethods ??= []).push(m.slice(1));
            else (f.methods ??= []).push(m);
          }
          break;
        }
        case 'redirect': case 'redirect-rule': case 'rewrite': {
          let res = value.replace(/^abp-resource:/, '').replace(/:-?\d+$/, '');
          if (res === 'none') { if (!exception) return null; f.redirect = 'none'; break; }
          f.redirect = res; break;
        }
        case 'empty': f.redirect = 'empty'; break;
        case 'mp4': f.redirect = 'noopmp4-1s'; break;
        case 'removeparam': case 'queryprune': {
          if (neg) return null;
          f.removeparam = value; break;
        }
        case 'csp': f.csp = value; break;
        default:
          ctx.unknownOptions?.add(name);
          return null;
      }
    }
  }
  return f;
}

// ABP pattern -> DNR condition (urlFilter / regexFilter / requestDomains).
function patternCondition(pattern, matchCase) {
  if (pattern === '' || pattern === '*' || pattern === '|' || pattern === '||') return {};

  // regex
  if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
    const re = pattern.slice(1, -1);
    // RE2 has no lookaround or backreferences
    if (/\(\?[=!<]|\\[1-9]/.test(re)) return null;
    // RE2 rejects repetitions over 1000
    if (/\{(\d{4,}|\d+,\d{4,})\}/.test(re)) return null;
    try { new RegExp(re); } catch { return null; }
    return { regexFilter: re, isUrlFilterCaseSensitive: matchCase };
  }

  // ||host^ / ||host — hostname only
  const hostOnly = pattern.match(/^\|\|([a-z0-9.\-_\u0080-￿]+)(\^\|?|\|)?$/i);
  if (hostOnly && !hostOnly[1].includes('*')) {
    const host = toAsciiHost(hostOnly[1].replace(/\.$/, ''));
    if (host && host.includes('.')) return { requestDomains: [host] };
    if (!host) return null;
  }

  // urlFilter accepts exactly the ABP syntax, but ASCII only
  let p = pattern;
  if (/[^\x00-\x7f]/.test(p)) {
    const m = p.match(/^(\|\|)([^/^:*?|]+)(.*)$/);
    if (!m) return null;
    const host = toAsciiHost(m[2]);
    if (!host || /[^\x00-\x7f]/.test(m[3])) return null;
    p = m[1] + host + m[3];
  }
  if (p.startsWith('||*')) p = p.slice(2);
  // plain "host", no anchors (e.g. from clean hosts lists) — treated as a substring, as in ABP
  return { urlFilter: p, isUrlFilterCaseSensitive: matchCase };
}

/** Canonical text for $badfilter: the filter without the badfilter option. */
export function badfilterKey(text) {
  const exc = text.startsWith('@@') ? '@@' : '';
  const s = exc ? text.slice(2) : text;
  const i = findOptionsStart(s);
  if (i === -1) return text;
  const opts = splitOptions(s.slice(i + 1)).map((o) => o.trim()).filter((o) => o && o !== 'badfilter').sort();
  return exc + s.slice(0, i) + (opts.length ? '$' + opts.join(',') : '');
}

/**
 * Turns a parsed filter into a DNR rule (no id). `redirects` maps the
 * resource name to its path in the extension. Returns null if it can't.
 */
export function toDnrRule(f, redirects) {
  if (f.badfilter || f.cosmeticException) return null;

  const cond = patternCondition(f.pattern, f.matchCase);
  if (!cond) return null;
  const condition = { ...cond };

  if (f.types) condition.resourceTypes = [...new Set(f.types)];
  if (f.excludedTypes.length) {
    const ex = new Set(f.excludedTypes);
    if (f.types) condition.resourceTypes = condition.resourceTypes.filter((t) => !ex.has(t));
    else condition.excludedResourceTypes = [...ex];
    if (condition.resourceTypes && !condition.resourceTypes.length) return null;
  }
  if (f.domainType) condition.domainType = f.domainType;

  if (f.initiator) {
    if (f.initiator.include.length) condition.initiatorDomains = f.initiator.include;
    else if (f.initiator.includeEntities.length) return null; // entities only: we can't
    if (f.initiator.exclude.length) condition.excludedInitiatorDomains = f.initiator.exclude;
  }
  if (f.request) {
    if (f.request.include.length) {
      if (condition.requestDomains) {
        // ||host^$to=... — rare intersection, keep only the pattern
      } else condition.requestDomains = f.request.include;
    } else if (f.request.includeEntities.length) return null;
    if (f.request.exclude.length) condition.excludedRequestDomains = f.request.exclude;
  }
  if (f.denyallow.length) condition.excludedRequestDomains = [...(condition.excludedRequestDomains || []), ...f.denyallow];
  if (f.methods) condition.requestMethods = f.methods;
  if (f.excludedMethods) condition.excludedRequestMethods = f.excludedMethods;

  // a filter with no restriction at all would block the whole internet
  const unrestricted = !condition.urlFilter && !condition.regexFilter && !condition.requestDomains
    && !condition.initiatorDomains && !condition.resourceTypes;
  if (unrestricted && !f.exception) return null;
  if (unrestricted && f.exception && !f.csp && !f.removeparam && !f.redirect) return null;

  // ---- the action
  if (f.exception) {
    if (f.redirect || f.removeparam || f.csp) return null; // exceptions to modifiers: unsupported
    if (f.documentException) {
      // @@||site^$document -> the whole page is allowed
      const c = { ...condition, resourceTypes: ['main_frame', 'sub_frame'] };
      delete c.excludedResourceTypes;
      return { priority: PRIORITY.allow, action: { type: 'allowAllRequests' }, condition: c };
    }
    return { priority: PRIORITY.allow, action: { type: 'allow' }, condition };
  }

  if (f.removeparam !== null) {
    if (!condition.resourceTypes) condition.resourceTypes = ['main_frame', 'sub_frame', 'xmlhttprequest'];
    const v = f.removeparam;
    if (v === '') {
      return { priority: PRIORITY.removeparam, action: { type: 'redirect', redirect: { transform: { query: '' } } }, condition };
    }
    if (v.startsWith('/') || v.includes('|')) return null; // regex: DNR accepts exact names only
    return { priority: PRIORITY.removeparam, action: { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: [v] } } } }, condition };
  }

  if (f.csp !== null) {
    if (!f.csp) return null;
    if (!condition.resourceTypes) condition.resourceTypes = ['main_frame', 'sub_frame'];
    return {
      priority: PRIORITY.csp,
      action: { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'append', value: f.csp }] },
      condition,
    };
  }

  if (f.redirect) {
    const path = resolveRedirect(f.redirect, condition, redirects);
    if (!path) return null;
    return {
      priority: f.important ? PRIORITY.importantRedirect : PRIORITY.redirect,
      action: { type: 'redirect', redirect: { extensionPath: path } },
      condition,
    };
  }

  return { priority: f.important ? PRIORITY.importantBlock : PRIORITY.block, action: { type: 'block' }, condition };
}

const EMPTY_BY_TYPE = { script: 'noopjs', stylesheet: 'noopcss', sub_frame: 'noopframe', image: '1x1-transparent.gif', media: 'noopmp4-1s' };

function resolveRedirect(name, condition, redirects) {
  if (!redirects) return null;
  if (name === 'empty') {
    const t = condition.resourceTypes?.[0];
    name = EMPTY_BY_TYPE[t] || 'nooptext';
  }
  return redirects[name] || null;
}

// ------------------------------------------------------------ cosmetic

const PROCEDURAL_RE = /:(?:has-text|upward|remove|remove-attr|remove-class|style|matches-css|matches-css-before|matches-css-after|matches-attr|matches-path|matches-prop|matches-media|min-text-length|watch-attr|xpath|others|-abp-has|-abp-contains|contains|if|if-not|nth-ancestor|shadow)\(/;

/**
 * Normalizes the body of a cosmetic filter. Returns
 *  { type: 'css', selector }            pure CSS selector
 *  { type: 'style', selector, style }   selector + CSS declarations
 *  { type: 'procedural', selector }     evaluated in the page
 *  { type: 'scriptlet', name, args }
 *  null                                 unsupported
 */
export function parseCosmeticBody(sep, body) {
  if (sep === '#%#') {
    // AdGuard: //scriptlet('name', 'arg')
    return null;
  }
  if (sep === '#$#') {
    // AdGuard CSS injection: "selector { style }"
    const m = body.match(/^(.+?)\s*\{\s*([^{}]*)\s*\}$/);
    if (!m) return null;
    return { type: 'style', selector: m[1], style: m[2] };
  }
  if (body.startsWith('+js(')) {
    if (!body.endsWith(')')) return null;
    return { type: 'scriptlet', raw: body };
  }
  if (body.startsWith('^')) return null; // html filtering

  let sel = body.replace(/:-abp-has\(/g, ':has(').replace(/:-abp-contains\(/g, ':has-text(').replace(/:contains\(/g, ':has-text(');

  // trailing ":style(...)" on a pure selector -> plain CSS
  const style = sel.match(/^(.*?):style\((.*)\)$/);
  if (style && !PROCEDURAL_RE.test(style[1])) {
    if (/url\(|expression|javascript:/i.test(style[2])) return null;
    return { type: 'style', selector: style[1], style: style[2] };
  }
  if (sep === '#?#' || PROCEDURAL_RE.test(sel)) {
    if (/:xpath\(/.test(sel) || PROCEDURAL_RE.test(sel)) return { type: 'procedural', selector: sel };
  }
  if (/:style\(/.test(sel)) return { type: 'procedural', selector: sel };
  return { type: 'css', selector: sel };
}

/**
 * The domains of a cosmetic filter: "a.com,~b.com,google.*".
 * `dropped` counts the entries we can't express (regex, "site>>");
 * a filter with no valid domain does NOT become generic.
 */
export function parseCosmeticDomains(prefix) {
  const include = [], exclude = [];
  let dropped = 0;
  if (!prefix) return { include, exclude, dropped };
  for (let d of prefix.split(',')) {
    d = d.trim().toLowerCase();
    if (!d) continue;
    const neg = d.startsWith('~');
    if (neg) d = d.slice(1);
    let host = null;
    if (d.startsWith('/') || d.includes('>>')) host = null;
    else if (!d.endsWith('.*')) host = toAsciiHost(d);
    else {
      const base = toAsciiHost(d.slice(0, -2));
      host = base ? base + '.*' : null;
    }
    if (!host) { if (!neg) dropped++; continue; }
    (neg ? exclude : include).push(host);
  }
  return { include, exclude, dropped };
}

/** Key for generic cosmetics: the first class / id if the selector starts with it. */
export function genericKey(selector) {
  const m = selector.match(/^([.#])((?:[\w-]|\\.)+)/);
  if (!m) return null;
  const rest = selector.slice(m[0].length);
  // ".ad, .x" would have two keys — treat as high-generic
  if (rest.includes(',')) return null;
  return m[1] + m[2].replace(/\\(.)/g, '$1');
}

/** FNV-1a: splits specific cosmetics into shards (same function at build time and in the extension). */
export function hostHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Lookup candidates for a hostname (suffixes + entities). */
export function hostnameCandidates(hostname) {
  const out = [];
  const labels = hostname.split('.');
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');
    out.push(suffix);
    const parts = labels.slice(i);
    // entities: google.* covers google.ro, google.co.uk
    if (parts.length >= 2) out.push(parts.slice(0, -1).join('.') + '.*');
    if (parts.length >= 3) out.push(parts.slice(0, -2).join('.') + '.*');
  }
  return out;
}

/**
 * The arguments of "+js(name, a, b)" per uBO rules: a comma separates,
 * "\," is a literal comma, and an argument may be quoted.
 */
export function parseScriptletArgs(inner) {
  const s = inner.trim();
  if (!s) return [];
  const out = [];
  let i = 0;
  while (i <= s.length) {
    while (s[i] === ' ') i++;
    const q = s[i];
    if (q === "'" || q === '"' || q === '`') {
      let j = i + 1, v = '', closed = false;
      while (j < s.length) {
        if (s[j] === '\\' && s[j + 1] === q) { v += q; j += 2; continue; }
        if (s[j] === q) {
          let k = j + 1;
          while (s[k] === ' ') k++;
          if (k >= s.length || s[k] === ',') { closed = true; i = k + 1; break; }
        }
        v += s[j++];
      }
      if (closed) { out.push(v); continue; }
    }
    let v = '';
    while (i < s.length && s[i] !== ',') {
      if (s[i] === '\\' && s[i + 1] === ',') { v += ','; i += 2; continue; }
      v += s[i++];
    }
    out.push(v.trim());
    i++;
  }
  return out;
}
