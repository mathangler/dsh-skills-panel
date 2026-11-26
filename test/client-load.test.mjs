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

const styleTags = [];
const styleTag = { dataset: {}, textContent: '', remove() {} };

const React = {
  // Real enough to walk: the icon is asserted on its element tree, so the
  // factory has to keep the type, props and children it was handed.
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useContext: () => undefined,
  createContext: () => ({}),
};

let captured = null;
const win = { __ModuleLoader__: { load: (m) => { captured = m; } } };
// eslint-disable-next-line no-new-func
new Function('window', 'document', src)(win, {
  createElement: () => styleTag,
  head: { appendChild: (t) => styleTags.push(t) },
});

// ── bundle contract ─────────────────────────────────────────────────────────
console.log('--- bundle contract ---');
check('registers on __ModuleLoader__', captured !== null);
check('bundle id equals the package name', captured !== null && captured.id === pkg.name, captured && captured.id);

const registered = {};
const ctx = {
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
  slots: {
    inject: (n, fn) => fn(),
    register: (reg, comp) => { registered[reg.name] = { reg, comp }; return () => {}; },
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
const sheet = String(styleTag.textContent);
check('stylesheet carries the panel rules', sheet.includes('.dshsk-wrap{'));
check('registers the skills section',
  registered['settings.section'] !== undefined && registered['settings.section'].reg.id === 'skills');
check('section label is a thunk',
  registered['settings.section'] !== undefined
    && typeof registered['settings.section'].reg.label === 'function');

// ── the settings nav glyph ──────────────────────────────────────────────────
// Reported symptom: the settings sidebar showed the generic settings gear. The
// shell draws a section's glyph from `settings.section.icon`, matched by the
// section's own id, and falls back to the gear when nothing answers — so an
// unregistered third-party section can never draw its own.
console.log('\n--- the settings nav glyph ---');
const iconEntry = registered['settings.section.icon'];
check('registers a settings.section.icon', iconEntry !== undefined);
check('addressed by the section\'s own id',
  iconEntry !== undefined && iconEntry.reg.id === registered['settings.section'].reg.id,
  iconEntry === undefined ? 'not registered' : iconEntry.reg.id);

const iconEl = iconEntry === undefined ? null : iconEntry.comp({ size: 16, active: false });
check('the glyph is an svg', iconEl !== null && iconEl.type === 'svg', iconEl && iconEl.type);
check('it fills the requested box', iconEl !== null && iconEl.props.width === 16 && iconEl.props.height === 16);
check('drawn on the shipped 16-unit grid', iconEl !== null && iconEl.props.viewBox === '0 0 16 16');
check('it inherits the row colour', iconEl !== null && iconEl.props.stroke === 'currentColor');
check('outline style, matching the shipped glyphs',
  iconEl !== null && iconEl.props.fill === 'none'
    && iconEl.props.strokeLinecap === 'round' && iconEl.props.strokeLinejoin === 'round');
check('hidden from assistive tech, since the row owns the label',
  iconEl !== null && iconEl.props['aria-hidden'] === 'true');
check('it is a cap, not a placeholder', iconEl !== null && iconEl.children.length === 3,
  iconEl === null ? '' : String(iconEl.children.length));
check('every part is a path with geometry',
  iconEl !== null && iconEl.children.every((c) => c.type === 'path' && typeof c.props.d === 'string' && c.props.d !== ''));
const bigIcon = iconEntry === undefined ? null : iconEntry.comp({ size: 32, active: true });
check('it honours the size the row asks for', bigIcon !== null && bigIcon.props.width === 32);
check('a missing size still draws', iconEntry !== undefined && iconEntry.comp({}).props.width === 16);

// The DOM-recolouring approach this replaced must stay gone: it scanned the
// document on every mutation and could still paint the gear first.
check('no document-scanning glyph hack survives',
  !src.includes('MutationObserver') && !src.includes('data-dsh-skills-nav')
    && !sheet.includes('mask:url("data:image/svg+xml'));

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

// ── a removed skill leaves the list at once ─────────────────────────────────
// Reported symptom: after Remove the row stayed on screen, and a second Remove
// answered "Skill not found" — the host's refresh had raced the watcher, so the
// deleted skill was still in the catalog the reload returned. The success path
// now drops the row itself before asking again.
console.log('\n--- a removed row leaves the list at once ---');
check('the success path drops the row as well as reloading',
  /dropOne\(s\.name\);\s*load\(pp\);/.test(src));
check('the drop keeps every other skill',
  src.includes('return cur.filter(function (x) { return x.name !== name; });'));

// ── the check asks, it does not download ────────────────────────────────────
// Reported symptom: a check took four and a half minutes on a slow link because
// it downloaded every tracked repository to compare content.
console.log('\n--- the update check is cheap ---');
check('the background check reuses a recent answer',
  src.includes("check-updates', { projectPath: sc, reuse: true }"));
check('the button asks for a fresh answer',
  src.includes("check-updates', { projectPath: pp, force: true }"));
check('the panel says how old its answer is', src.includes("tt('lastCheck')") && src.includes('lastCheckText'));
check('and counts the age in minutes rather than staying silent',
  src.includes("tt('minutesAgo')") && src.includes('60000'));
check('both languages describe the cheap check',
  src.includes("autoHint: 'Checks compare commit ids, so nothing is downloaded.'")
    && src.includes('检查只比对提交编号'));

console.log('');
if (failed.length > 0) {
  console.error('FAILED: ' + failed.length + ' of ' + (passed + failed.length) + ': ' + failed.join('; '));
  process.exit(1);
}
console.log('OK: ' + passed + ' checks — bundle contract, method agreement, UI guards, settings nav glyph.');