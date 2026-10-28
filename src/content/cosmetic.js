// Content script (isolated world, document_start, all frames).
// Asks the service worker for the host's CSS, then:
//  - collects the page's classes / ids for generic cosmetics
//  - runs the procedural filters (:has-text, :upward, :remove etc.)

(() => {
  if (globalThis.__hushCosmetic) return;
  globalThis.__hushCosmetic = true;

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  let hideAttr = 'hush-hidden';

  send({ type: 'cosmetic:init', url: location.href }).then((res) => {
    if (!res || res.off) return;
    hideAttr = res.hideAttr || hideAttr;
    if (res.generic) startGeneric();
    if (res.procedural?.length) startProcedural(res.procedural);
  });

  // ---------------------------------------------------------- generic

  function startGeneric() {
    const seen = new Set();
    let pending = [];
    let timer = 0;

    const flush = () => {
      timer = 0;
      if (!pending.length) return;
      const tokens = pending;
      pending = [];
      send({ type: 'cosmetic:generic', url: location.href, tokens });
    };
    const queue = (t) => {
      if (seen.has(t)) return;
      seen.add(t);
      pending.push(t);
      if (!timer) timer = setTimeout(flush, pending.length > 200 ? 0 : 16);
    };
    const scanElement = (el) => {
      const id = el.id;
      if (id && typeof id === 'string') queue('#' + id);
      const cl = el.classList;
      if (cl) for (let i = 0; i < cl.length; i++) queue('.' + cl[i]);
    };
    const scanTree = (root) => {
      if (root.nodeType !== 1) return;
      scanElement(root);
      const all = root.querySelectorAll('[id],[class]');
      for (let i = 0; i < all.length; i++) scanElement(all[i]);
    };

    if (document.documentElement) scanTree(document.documentElement);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') scanElement(r.target);
        else for (const n of r.addedNodes) scanTree(n);
      }
    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id'] });
  }

  // ---------------------------------------------------------- procedural

  const OPERATORS = new Set(['has-text', 'has', 'not', 'if', 'if-not', 'upward', 'nth-ancestor',
    'matches-css', 'matches-css-before', 'matches-css-after', 'matches-attr', 'matches-path',
    'matches-media', 'matches-prop', 'min-text-length', 'xpath', 'watch-attr', 'others', 'shadow',
    'remove', 'style', 'remove-attr', 'remove-class']);
  const ACTIONS = new Set(['remove', 'style', 'remove-attr', 'remove-class']);

  // Splits "div.ad:has-text(x) > span:upward(2)" into css / operator steps.
  function compile(sel) {
    const steps = [];
    let css = '';
    let i = 0;
    let depthBracket = 0;
    while (i < sel.length) {
      const c = sel[i];
      if (c === '\\') { css += c + (sel[i + 1] || ''); i += 2; continue; }
      if (c === '"' || c === "'") {
        const end = sel.indexOf(c, i + 1);
        const stop = end === -1 ? sel.length : end + 1;
        css += sel.slice(i, stop);
        i = stop;
        continue;
      }
      if (c === '[') depthBracket++;
      if (c === ']') depthBracket--;
      if (c === ':' && depthBracket === 0) {
        const m = /^:([a-z-]+)\(/.exec(sel.slice(i));
        if (m && OPERATORS.has(m[1])) {
          // :has / :not with a pure CSS argument stay in the native selector
          const argStart = i + m[0].length;
          const argEnd = matchParen(sel, argStart - 1);
          if (argEnd === -1) return null;
          const arg = sel.slice(argStart, argEnd);
          const native = (m[1] === 'has' || m[1] === 'not') && !hasProcedural(arg);
          if (native) { css += sel.slice(i, argEnd + 1); i = argEnd + 1; continue; }
          if (css.trim() || css.length) steps.push({ css });
          css = '';
          steps.push({ op: m[1], arg });
          i = argEnd + 1;
          continue;
        }
      }
      css += c;
      i++;
    }
    if (css.trim()) steps.push({ css });
    if (!steps.length) return null;
    const last = steps[steps.length - 1];
    const action = last.op && ACTIONS.has(last.op) ? steps.pop() : null;
    return { steps, action };
  }

  function hasProcedural(s) {
    return /:(has-text|upward|nth-ancestor|matches-[a-z]+|min-text-length|xpath|watch-attr|remove|style|if|if-not|others|shadow)\(/.test(s)
      || /:(?:has|not)\([^)]*:(?:has-text|upward|matches-)/.test(s);
  }

  function matchParen(s, open) {
    let depth = 0;
    for (let i = open; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') { i++; continue; }
      if (c === '"' || c === "'") { const e = s.indexOf(c, i + 1); if (e === -1) return -1; i = e; continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return i;
    }
    return -1;
  }

  function toRegex(arg) {
    const m = /^\/(.+)\/([imsu]*)$/.exec(arg);
    if (m) { try { return new RegExp(m[1], m[2]); } catch { return /(?!)/; } }
    return new RegExp(arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }

  const MARK = 'hush-step';
  // Applies a CSS fragment relative to the current nodes.
  function relative(nodes, css) {
    const t = css.trim();
    if (!t) return nodes;
    if (/^[\s>+~]/.test(css)) {
      for (const n of nodes) n.setAttribute(MARK, '');
      let out = [];
      try { out = [...document.querySelectorAll(`[${MARK}]${/^\s/.test(css) && !/^\s*[>+~]/.test(css) ? ' ' : ''}${css}`)]; } catch { }
      for (const n of nodes) n.removeAttribute(MARK);
      return out;
    }
    try { return nodes.filter((n) => n.matches(t)); } catch { return []; }
  }

  function run(compiled, root) {
    const { steps } = compiled;
    let nodes;
    let i = 0;
    if (root) nodes = [root];
    else if (steps[0].css !== undefined) {
      try { nodes = [...document.querySelectorAll(steps[0].css.trim() || '*')]; } catch { return []; }
      i = 1;
    } else {
      nodes = [...document.querySelectorAll('body *')];
    }
    for (; i < steps.length && nodes.length; i++) {
      const s = steps[i];
      nodes = s.css !== undefined ? relative(nodes, s.css) : applyOp(s.op, s.arg, nodes);
    }
    return nodes;
  }

  // ":has(> .x:has-text(y))" — the argument is evaluated relative to each node
  function subMatches(node, arg) {
    const c = compileCached(/^\s*[>+~]/.test(arg) ? arg : ' ' + arg);
    if (!c) return false;
    const steps = [{ css: '' }, ...c.steps];
    return run({ steps }, node).length > 0;
  }

  function selfMatches(node, arg) {
    if (!hasProcedural(arg)) { try { return node.matches(arg); } catch { return false; } }
    const c = compileCached(arg);
    if (!c) return false;
    // the first css step must match the node itself
    const steps = c.steps[0].css !== undefined ? [{ css: c.steps[0].css }, ...c.steps.slice(1)] : c.steps;
    return run({ steps }, node).includes(node);
  }

  function applyOp(op, arg, nodes) {
    switch (op) {
      case 'has-text': { const re = toRegex(arg); return nodes.filter((n) => re.test(n.textContent)); }
      case 'has': case 'if': return nodes.filter((n) => subMatches(n, arg));
      case 'if-not': return nodes.filter((n) => !subMatches(n, arg));
      case 'not': return nodes.filter((n) => !selfMatches(n, arg));
      case 'upward': case 'nth-ancestor': {
        const num = /^\d+$/.test(arg.trim()) ? +arg : 0;
        const out = new Set();
        for (const n of nodes) {
          let p = n;
          if (num) { for (let k = 0; k < num && p; k++) p = p.parentElement; }
          else { try { p = n.parentElement?.closest(arg); } catch { p = null; } }
          if (p) out.add(p);
        }
        return [...out];
      }
      case 'matches-css': case 'matches-css-before': case 'matches-css-after': {
        const pseudo = op === 'matches-css' ? null : op === 'matches-css-before' ? '::before' : '::after';
        const i = arg.indexOf(':');
        if (i === -1) return [];
        const prop = arg.slice(0, i).trim();
        const re = toRegex(arg.slice(i + 1).trim());
        return nodes.filter((n) => re.test(getComputedStyle(n, pseudo).getPropertyValue(prop)));
      }
      case 'matches-attr': {
        const m = /^\s*("?)(.+?)\1\s*(?:=\s*("?)(.*)\3)?\s*$/.exec(arg);
        if (!m) return [];
        const nameRe = toRegex(m[2]);
        const valRe = m[4] !== undefined ? toRegex(m[4]) : null;
        return nodes.filter((n) => [...n.attributes].some((a) => nameRe.test(a.name) && (!valRe || valRe.test(a.value))));
      }
      case 'matches-path': {
        const re = toRegex(arg);
        return re.test(location.pathname + location.search) ? nodes : [];
      }
      case 'matches-media': return matchMedia(arg).matches ? nodes : [];
      case 'min-text-length': return nodes.filter((n) => n.textContent.length >= +arg);
      case 'xpath': {
        const out = [];
        for (const n of nodes) {
          let r;
          try { r = document.evaluate(arg, n, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null); } catch { return []; }
          for (let k = 0; k < r.snapshotLength; k++) if (r.snapshotItem(k).nodeType === 1) out.push(r.snapshotItem(k));
        }
        return out;
      }
      case 'watch-attr': return nodes;
      default: return []; // others, shadow, matches-prop: unsupported
    }
  }

  const compiledCache = new Map();
  function compileCached(s) {
    if (!compiledCache.has(s)) compiledCache.set(s, compile(s));
    return compiledCache.get(s);
  }

  function act(action, nodes) {
    for (const n of nodes) {
      if (!action) { n.setAttribute(hideAttr, ''); continue; }
      switch (action.op) {
        case 'remove': n.remove(); break;
        case 'style': n.style.cssText += ';' + action.arg.split(';').map((d) => d.trim() && (d.includes('!important') ? d : d + ' !important')).filter(Boolean).join(';'); break;
        case 'remove-attr': {
          const re = toRegex(action.arg);
          for (const a of [...n.attributes]) if (re.test(a.name)) n.removeAttribute(a.name);
          break;
        }
        case 'remove-class': {
          const re = toRegex(action.arg);
          for (const c of [...n.classList]) if (re.test(c)) n.classList.remove(c);
          break;
        }
      }
    }
  }

  function startProcedural(selectors) {
    const filters = selectors.map((s) => compileCached(s)).filter((c) => c && c.steps.length);
    if (!filters.length) return;
    // xpath and :matches-path may go without css; the rest must start with css
    const apply = () => {
      for (const f of filters) {
        const nodes = run(f).filter((n) => !n.hasAttribute(hideAttr));
        if (nodes.length) act(f.action, nodes);
      }
    };
    let scheduled = false;
    let last = 0;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      const wait = Math.max(0, 100 - (performance.now() - last));
      setTimeout(() => { scheduled = false; last = performance.now(); apply(); }, wait);
    };
    schedule();
    new MutationObserver(schedule).observe(document, { childList: true, subtree: true, characterData: true });
  }
})();
