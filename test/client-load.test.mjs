/**
 * Client bundle tests.
 *
 * Loads `lib/client.js` the way the browser loader does and mounts it against a
 * stub Cordis context. React is stubbed, so the component tree is not rendered —
 * what is checked is the bundle contract, the wiring, and a set of literal
 * source guards for behaviour this harness cannot render.
 *
 * Those guards exist because two UI regressions once shipped with a green
 * suite: the check has to assert the exact thing that broke, not a proxy.
 */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const { createHandlers } = await import(new URL('../lib/host-core.js', import.meta.url).href);

let passed = 0;
const failed = [];
const check = (label, cond, detail) => {
  if (cond) {
    passed += 1;
    console.log('ok   ' + label);
  } else {
    failed.push(label);
    console.log('FAIL ' + label + (detail === undefined ? '' : '  ' + detail));
  }
};

const NAV = 'data-dsh-skills-nav';

/** Stand-in for one rendered settings-nav row. */
function fakeButton(tagName, text) {
  const attrs = new Set();
  return {
    nodeType: 1,
    tagName,
    textContent: text,
    firstElementChild: tagName === null ? null : { tagName },
    parentNode: null,
    isConnected: true,
    hasAttribute: (n) => attrs.has(n),
    setAttribute: (n) => attrs.add(n),
    querySelectorAll: () => [],
    attrs,
  };
}
const ourRowZh = fakeButton('SVG', '技能');
const ourRowEn = fakeButton('SVG', 'Skills');
const modelsRow = fakeButton('SVG', '模型');
const notANavRow = fakeButton('SPAN', '技能');
const allButtons = [ourRowZh, ourRowEn, modelsRow, notANavRow];

let docScans = 0;
const fakeDocument = {
  nodeType: 9,
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild: (t) => styleTags.push(t) },
  body: {},
  querySelectorAll: (sel) => {
    docScans += 1;
    return sel === 'button' ? allButtons : [];
  },
  querySelector: () => (ourRowZh.attrs.size > 0 ? ourRowZh : null),
};

const styleTags = [];
let observerCallback = null;
let observerTarget = null;
globalThis.MutationObserver = class {
  constructor(cb) { observerCallback = cb; }
  observe(target) { observerTarget = target; }
  disconnect() { observerCallback = null; }
};

const React = {
  createElement: () => ({ type: 'stub' }),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useContext: () => undefined,
  createContext: () => ({}),
};

let captured = null;
const win = { __ModuleLoader__: { load: (m) => { captured = m; } } };
// eslint-disable-next-line no-new-func
new Function('window', 'document', src)(win, fakeDocument);

// ── bundle contract ─────────────────────────────────────────────────────────
console.log('--- bundle contract ---');
check('registers on __ModuleLoader__', captured !== null);
check('bundle id equals the package name', captured !== null && captured.id === pkg.name, captured && captured.id);

let registered = null;
const ctx = {
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  slots: {
    inject: (n, fn) => fn(),
    register: (reg, comp) => { registered = { reg, comp }; return () => {}; },
  },
  locale: {
    getSnapshot: () => ({ active: 'zh', locales: [{ id: 'en' }, { id: 'zh' }] }),
    register: () => () => {},
    bind: () => null,
    subscribe: () => () => {},
  },
  uiWorkspace: { pickDirectory: () => Promise.resolve(null) },
};

const mod = captured.factory((s) => {
  if (s === 'react') return React;
  throw new Error('non-baseline specifier required: ' + s);
});
check('exports apply', typeof mod.apply === 'function');
check('injects uiWorkspace', Array.isArray(mod.inject) && mod.inject.includes('uiWorkspace'));
check('does not inject connection', Array.isArray(mod.inject) && !mod.inject.includes('connection'));

mod.apply(ctx);
check('stylesheet injected', styleTags.length === 1, styleTags.length + ' tag(s)');
const sheet = styleTags[0] ? String(styleTags[0].textContent) : '';
check('stylesheet carries the panel rules', sheet.includes('.dshsk-wrap{'));
// The nav glyph was once dropped while porting the panel; the only symptom was
// the original gear quietly coming back.
check('stylesheet carries the nav glyph rule', sheet.includes('button[' + NAV + '] > svg{display:none}'));
check('stylesheet carries the nav mask', sheet.includes('mask:url("data:image/svg+xml'));
check('registers the skills section', registered !== null && registered.reg.id === 'skills');
check('section label is a thunk', registered !== null && typeof registered.reg.label === 'function');

// ── the panel and the host agree on the method set ──────────────────────────
console.log('\n--- client/host method agreement ---');
const hostKeys = Object.keys(createHandlers({ get: () => undefined, skills: { list: async () => [] } }, {})).sort();
const called = new Set();
for (const m of src.matchAll(/hostCall\('([^']+)'/g)) called.add(m[1]);
const calledSorted = [...called].sort();
check('every method the client calls exists on the host',
  calledSorted.every((k) => hostKeys.includes(k)),
  'client-only: ' + calledSorted.filter((k) => !hostKeys.includes(k)).join(', '));
check('adopt is wired from the client', called.has('adopt'));
// The rule established after the security review: nothing about a skill is
// fetched until the user asks for it by name.
check('no content fetch is wired into the search flow',
  !called.has('describe') && !called.has('preview'));

// ── search results ──────────────────────────────────────────────────────────
console.log('\n--- search results ---');
check('the search row renders no description', !src.includes('descText'));
check('view opens the skill page in a new tab',
  src.includes("window.open(url, '_blank', 'noopener,noreferrer')"));
check('a GitHub entry point is offered', src.includes("'https://github.com/' + r.source"));
check('the GitHub entry point is withheld for non-GitHub sources',
  src.includes('/^[^/.]+\\/[^/]+$/.test(String(source))'));

// ── adopting a source, and the update guard ─────────────────────────────────
console.log('\n--- adopt and update guard ---');
check('an untracked skill offers to be attached', src.includes('s.mode === undefined'));
// Exactly two calls: one that only reads the repository, one that commits.
// Anything else would mean the panel can attach without asking.
const adoptCalls = [...src.matchAll(/hostCall\('adopt',\s*\{([\s\S]{0,240}?)\}\)/g)].map((m) => m[1]);
check('attaching is two-phase from the client',
  adoptCalls.length === 2
    && adoptCalls.some((c) => !c.includes('confirm'))
    && adoptCalls.some((c) => c.includes('confirm: true')),
  adoptCalls.length + ' adopt call(s)');
check('the confirm step shows what was found', src.includes('prev.found.skillPath'));
check('a locally edited skill asks before being replaced', src.includes('r.locallyModified'));
check('the forced update passes force', src.includes('force: force === true'));
check('local edits are surfaced as a tag', src.includes("tt('localEdited')"));
check('the dead dictionary keys stay gone',
  !src.includes('descLoading') && !src.includes('viaNote') && !src.includes('skillDoc:'));
check('both languages carry the new keys',
  src.includes("track: 'Track source'") && src.includes("track: '关联来源'"));

// ── the switch is the shared DSH primitive ──────────────────────────────────
// A skills row's toggle sits beside toggles the plugin panel draws with
// `@deepseek-ai/dsh-client-ui-primitives`. This panel cannot import it — only
// React and the baseline seeds resolve — so the copy has to be checked instead.
console.log('\n--- the switch matches the shared primitive ---');
check('geometry matches Switch.module.css',
  sheet.includes('.dshsk-switch{box-sizing:border-box;position:relative;flex:0 0 auto;'
    + 'width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;'));
check('the unchecked track is the primitive colour',
  sheet.includes('background:var(--dsw-alias-border-l3);cursor:pointer}'));
check('the checked track is the brand colour',
  sheet.includes('.dshsk-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}'));
check('the thumb is the primitive thumb',
  sheet.includes('.dshsk-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;'));
check('the unchecked thumb uses the switch token', sheet.includes('--dsw-alias-switch-thumb'));
check('the checked thumb travels 16px', sheet.includes('transform:translateX(16px)') && sheet.includes('120ms ease'));
check('the focus ring is the global one',
  sheet.includes('outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color'));
check('a busy switch dims like the primitive',
  sheet.includes('.dshsk-switch:disabled{cursor:default;opacity:.5}'));
check('state rides on aria-checked, and no parallel class survived',
  sheet.includes('[aria-checked="true"]') && !sheet.includes('dshsk-switch-on') && !sheet.includes('dshsk-knob'));
check('a write in flight disables the control', src.includes('disabled: toggleBusy === s.name'));

// ── nav marking ─────────────────────────────────────────────────────────────
console.log('\n--- nav marking ---');
check('marks the row labelled in the active locale', ourRowZh.attrs.has(NAV));
check('marks the row labelled in the other locale', ourRowEn.attrs.has(NAV));
check('leaves other sections alone', !modelsRow.attrs.has(NAV));
check('ignores a button with the same text but no leading icon', !notANavRow.attrs.has(NAV));
check('observer installed on the document body', observerCallback !== null && observerTarget === fakeDocument.body);

const MARK = NAV;
const fakeTextNode = { nodeType: 3, parentNode: null };
const emptyInsert = { nodeType: 1, tagName: 'DIV', querySelectorAll: () => [] };
const dialogInsert = { nodeType: 1, tagName: 'DIV', querySelectorAll: (s) => (s === 'button' ? [ourRowZh] : []) };

ourRowZh.attrs.delete(MARK);
const scansBeforeMount = docScans;
observerCallback([{ addedNodes: [dialogInsert] }]);
check('marks the row synchronously, with no timer in between', ourRowZh.attrs.has(MARK));
check('the mount scan was scoped, not document-wide', docScans === scansBeforeMount,
  docScans + ' vs ' + scansBeforeMount);

const scansBeforeBurst = docScans;
for (let i = 0; i < 200; i += 1) observerCallback([{ addedNodes: [fakeTextNode, emptyInsert] }]);
check('steady state does no document-wide scan', docScans === scansBeforeBurst,
  docScans + ' vs ' + scansBeforeBurst);

ourRowZh.attrs.delete(MARK);
const scansBeforeSweep = docScans;
observerCallback([{ addedNodes: [emptyInsert] }]);
check('nothing marked from an unrelated insert', !ourRowZh.attrs.has(MARK));
await new Promise((r) => setTimeout(r, 700));
check('backstop sweep finds the row after the delay',
  ourRowZh.attrs.has(MARK) && docScans > scansBeforeSweep);

console.log('');
if (failed.length > 0) {
  console.error('FAILED: ' + failed.length + ' of ' + (passed + failed.length) + ': ' + failed.join('; '));
  process.exit(1);
}
console.log('OK: ' + passed + ' checks — bundle contract, method agreement, UI guards, nav marking.');
