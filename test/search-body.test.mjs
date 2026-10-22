/**
 * dsh-skills-panel — reading the skills.sh search API.
 *
 * Reported from a profile whose `web` row sets
 * `fetchProvider: deepseek-fetch-api`. That provider exists to turn a **page**
 * into Markdown, and it hands `payload.content` straight through — so for a JSON
 * API the plugin received this:
 *
 *     {\"query\":\"pdf\"\,\"searchType\":\"fuzzy\"\,\"skills\"\:[{\"id\"\:...
 *
 * every `{ [ : , /` and `"` escaped, which `JSON.parse` rejects outright:
 * `Unexpected token '\'`. Search had gone through `ctx.web` on the assumption
 * that a fetch is a fetch; the capability is a deployment choice, and the choice
 * can change what a body *is*.
 *
 * The plugin now reads the API directly — the same rule its archive pipeline
 * already followed for codeload and api.github.com — and keeps the capability as
 * a fallback, unescaping what a page-converting provider returns.
 *
 * `node test/search-body.test.mjs` exits non-zero on any failed verdict.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandlers } from '../lib/host-core.js';

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

const cacheRoot = await mkdtemp(join(tmpdir(), 'dshsk-search-'));

/** The body skills.sh actually sends. */
const PLAIN = JSON.stringify({
  query: 'pdf',
  searchType: 'fuzzy',
  skills: [
    { id: 'anthropics/skills/pdf', source: 'anthropics/skills', skillId: 'pdf', name: 'pdf', installs: 214842 },
    { id: 'openai/skills/pdf', source: 'openai/skills', skillId: 'pdf', name: 'pdf', installs: 13328 },
  ],
  count: 2,
});

/** The same document after a page-to-Markdown provider has had it. */
const ESCAPED = PLAIN.replace(/(["\\/{}\[\]:,])/g, '\\$1');

/** A fetch result shaped like what the plugin reads. */
const okBody = (text) => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => text,
});

const calls = { urls: [] };

/** A ctx whose `web` capability is whatever the deployment configured. */
function makeCtx(webValue) {
  return {
    get: (n) => (n === 'web' ? webValue : undefined),
    skills: { list: async () => [], get: async () => undefined },
  };
}

const make = (fetchImpl, webValue) =>
  createHandlers(makeCtx(webValue), { cacheRoot, fetch: fetchImpl, platform: 'win32' });

console.log('== a plain JSON body ==');
let h = make(async (url) => { calls.urls.push(String(url)); return okBody(PLAIN); }, undefined);
let r = await h.search({ query: 'pdf' });
check('search succeeds', r.ok === true, r.error);
check('it read the skills.sh API directly',
  calls.urls.length === 1 && calls.urls[0].startsWith('https://www.skills.sh/api/search?'),
  calls.urls[0]);
check('the query is encoded into the URL', calls.urls[0].includes('q=pdf'));
check('the rows are mapped', r.results.length === 2 && r.results[0].source === 'anthropics/skills',
  JSON.stringify(r.results && r.results[0]));
check('the install count survives', r.results[0].installs === 214842, String(r.results[0].installs));

console.log('\n== the escaped body a page-converting provider returns ==');
// This is the regression. `JSON.parse` of it throws `Unexpected token '\'`.
let threw = false;
try { JSON.parse(ESCAPED); } catch (e) { threw = true; }
check('the escaped body really is unparseable as-is', threw);

calls.urls.length = 0;
h = make(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => { throw new Error('unreachable'); } }),
  { fetch: async () => ({ statusCode: 200, body: { kind: 'text', content: ESCAPED }, truncated: false }) });
r = await h.search({ query: 'pdf' });
check('search still succeeds through the fallback', r.ok === true, r.error);
check('and returns the same rows', r.results.length === 2 && r.results[1].source === 'openai/skills',
  JSON.stringify(r.results && r.results[1]));

console.log('\n== the direct read is not gated on the capability ==');
// A profile with no `web` row at all must still be able to search.
calls.urls.length = 0;
h = make(async (url) => { calls.urls.push(String(url)); return okBody(PLAIN); }, undefined);
r = await h.search({ query: 'pdf' });
check('search works with no web capability', r.ok === true, r.error);
check('and read it directly, once', calls.urls.length === 1, String(calls.urls.length));

console.log('\n== failures stay readable ==');
h = make(async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => '' }), undefined);
r = await h.search({ query: 'pdf' });
check('an HTTP failure names the status', r.ok === false && r.error.includes('503'), r.error);

h = make(async () => okBody('<html>not json</html>'), undefined);
r = await h.search({ query: 'pdf' });
check('a non-JSON body is reported, not thrown',
  r.ok === false && r.error === 'skills.sh did not answer with JSON.', r.error);
check('no raw parser message reaches the panel',
  r.ok === false && !/Unexpected token|is not valid JSON/.test(r.error), r.error);

h = make(async () => okBody(''), undefined);
r = await h.search({ query: 'pdf' });
check('an empty body is reported', r.ok === false && r.error.includes('empty'), r.error);

h = make(async () => { throw new Error('offline'); }, undefined);
r = await h.search({ query: 'pdf' });
check('an unreachable host is reported cleanly',
  r.ok === false && r.error.includes('could not reach skills.sh'), r.error);

console.log('\n== input bounds ==');
h = make(async () => okBody(PLAIN), undefined);
r = await h.search({ query: 'p' });
check('a one-character query is refused before fetching', r.ok === false && r.error.includes('two characters'), r.error);
r = await h.search({});
check('a missing query is refused', r.ok === false, r.error);

console.log('');
if (failed.length > 0) {
  console.error('FAILED: ' + failed.length + ' of ' + (passed + failed.length) + ': ' + failed.join('; '));
  process.exit(1);
}
console.log('OK: ' + passed + ' checks — the search body is read as JSON, whatever the web provider does.');
