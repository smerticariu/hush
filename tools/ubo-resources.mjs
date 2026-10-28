// Extracts the scriptlets and redirect resources from the uBlock Origin source
// (vendor/uBlock), statically, with acorn: uBO code is never executed here, only
// read as text and bundled into the extension, where it runs in web pages.

import { readFile, readdir } from 'node:fs/promises';
import { parse } from 'acorn';

const UBO = new URL('../vendor/uBlock/', import.meta.url);
const RES_DIR = new URL('src/js/resources/', UBO);
export const WAR_DIR = new URL('src/web_accessible_resources/', UBO);

function literal(node) {
  if (!node) return undefined;
  switch (node.type) {
    case 'Literal': return node.value;
    case 'ArrayExpression': return node.elements.map(literal);
    case 'Identifier': return { ref: node.name };
    case 'ObjectExpression': {
      const o = {};
      for (const p of node.properties) {
        const k = p.key.type === 'Identifier' ? p.key.name : p.key.value;
        o[k] = literal(p.value);
      }
      return o;
    }
    case 'TemplateLiteral':
      if (node.expressions.length === 0) return node.quasis.map((q) => q.value.cooked).join('');
      return undefined;
    default: return undefined;
  }
}

/**
 * Returns Map name -> { name, fnName, code, deps: [name], world, requiresTrust }
 * plus aliases: Map alias -> name.
 */
export async function loadScriptlets() {
  const functions = new Map();   // JS function name -> code
  const registrations = [];      // { fnName, details }
  // the files in resources/ plus the modules they import (e.g. ../urlskip.js)
  const queue = (await readdir(RES_DIR)).filter((f) => f.endsWith('.js')).map((f) => new URL(f, RES_DIR).href);
  const seen = new Set(queue);
  while (queue.length) {
    const url = queue.shift();
    const src = await readFile(new URL(url), 'utf8');
    const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
    for (let node of ast.body) {
      if (node.type === 'ImportDeclaration' && node.source.value.startsWith('.')) {
        const dep = new URL(node.source.value, url).href;
        if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
        continue;
      }
      if (node.type === 'ExportNamedDeclaration' && node.declaration) node = node.declaration;
      if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
        functions.set(node.id.name, src.slice(node.start, node.end));
      }
      if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression'
        && node.expression.callee.name === 'registerScriptlet') {
        const [fn, details] = node.expression.arguments;
        registrations.push({ fnName: fn.name, details: literal(details) });
      }
      // legacy form from scriptlets.js: builtinScriptlets.push({ name, fn, ... })
      if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression'
        && node.expression.callee.type === 'MemberExpression'
        && node.expression.callee.object.name === 'builtinScriptlets'
        && node.expression.callee.property.name === 'push') {
        const details = literal(node.expression.arguments[0]);
        registrations.push({ fnName: details.fn.ref, details });
      }
    }
  }

  const byFn = new Map(registrations.map((r) => [r.fnName, r.details.name]));
  const scriptlets = new Map();
  const aliases = new Map();
  for (const { fnName, details } of registrations) {
    const code = functions.get(fnName);
    if (!code) throw new Error(`function ${fnName} not found`);
    const deps = (details.dependencies || []).map((d) => (typeof d === 'object' ? byFn.get(d.ref) : d)).filter(Boolean);
    scriptlets.set(details.name, {
      name: details.name, fnName, code, deps,
      world: details.world || 'MAIN',
      requiresTrust: details.requiresTrust === true,
    });
    for (const a of details.aliases || []) aliases.set(a, details.name);
  }
  return { scriptlets, aliases };
}

/** uBO's web-accessible resources: Map name -> { file, aliases, data }. */
export async function loadRedirects() {
  const src = await readFile(new URL('src/js/redirect-resources.js', UBO), 'utf8');
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
  const decl = ast.body.find((n) => n.type === 'ExportDefaultDeclaration');
  const entries = decl.declaration.arguments[0].elements;
  const out = new Map();
  for (const e of entries) {
    const [name, details] = e.elements.map(literal);
    const d = details || {};
    const aliases = d.alias === undefined ? [] : Array.isArray(d.alias) ? d.alias : [d.alias];
    out.set(name, { file: name, aliases, data: d.data || 'text', params: d.params });
  }
  return out;
}

/** Like uBO's importScriptlet(): .js resources in WAR also become scriptlets. */
export function scriptletFromWar(name, code, details) {
  const body = code.replace(/\/\*.+?\*\//gs, '').trim();
  const fnName = `war_${name.replace(/[^a-z0-9]/gi, '_')}`;
  const wrapped = /^function\s+[^(]+\(.*?\)\s*\{.*\}$/s.test(body)
    ? `function ${fnName}(...args) { // ${name}\n(${body})(...args)\n}`
    : `function ${fnName}() { // ${name}\n${body}\n}`;
  return { name, fnName, code: wrapped, deps: details.dependencies || [], world: details.world || 'MAIN', requiresTrust: false };
}
