/**
 * dsh-skills-panel — the update check asks, and downloads nothing.
 *
 * Reported from a machine on a slow link: a check took four and a half minutes,
 * because it downloaded every tracked repository's archive to compare content.
 * Eight repositories came to 26.8 MB, dominated by one at 21 MB; the search tab
 * felt instant only because it fetches 754 bytes of JSON.
 *
 * A repository already publishes a commit id for every path, so the question
 * "has upstream moved?" is answerable without any content at all. This file
 * asserts that the check does exactly that, and nothing else:
 *
 *   - a check makes **zero** archive requests, whatever the answer;
 *   - an unchanged repository tip settles every skill inside it without a
 *     second request per skill;
 *   - a moved tip with an unmoved skill directory is still "current";
 *   - a moved skill directory is an update;
 *   - a recent answer is reused only when reuse is asked for, and `force`
 *     overrides everything;
 *   - when the API cannot answer, the archive path still gets it right.
 *
 * `node test/cheap-check.test.mjs` exits non-zero on any failed verdict.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHandlers } from '../lib/host-core.js';

const exec = promisify(execFile);
const failures = [];
function ok(condition, what, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${what}${condition || detail === undefined ? '' : '  <- ' + detail}`);
  if (!condition) failures.push(what);
}

/** --------------------------------------------------------------- fixtures */

const root = await mkdtemp(join(tmpdir(), 'dshsk-cheap-'));
const envHome = join(root, 'home');
const globalRoot = join(envHome, 'skills');
const cacheRoot = join(root, 'cache');
await mkdir(globalRoot, { recursive: true });
await mkdir(cacheRoot, { recursive: true });
process.env.DSH_HOME = envHome;

/** What the fake GitHub says about each repository. */
const git = new Map(); // 'owner/repo' -> { head, dirs: Map<path, sha> }
const calls = { api: [], archive: 0 };
let apiDown = false;

function repoState(slug, head, dirs = {}) {
  git.set(slug, { head, dirs: new Map(Object.entries(dirs)) });
}

/** The archive the fake codeload serves, so the fallback can still be tested. */
const archives = new Map();
async function defineArchive(slug, files) {
  const tree = join(root, 'up', slug.replace('/', '_'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(tree, ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  const tgz = join(root, slug.replace('/', '_') + '.tgz');
  await exec('tar', ['-czf', tgz, '-C', tree, '.']);
  archives.set(slug, await readFile(tgz));
}

const fakeFetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://api.github.com/')) {
    calls.api.push(u);
    if (apiDown) throw new Error('network unreachable');
    const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/commits(\?.*)?$/.exec(u);
    if (m === null) return jsonRes(404, { message: 'Not Found' });
    const state = git.get(m[1]);
    if (state === undefined) return jsonRes(404, { message: 'Not Found' });
    const q = m[2] || '';
    const pm = /[?&]path=([^&]*)/.exec(q);
    if (pm === null) return jsonRes(200, [{ sha: state.head }]);
    const path = decodeURIComponent(pm[1]);
    const sha = state.dirs.get(path);
    return sha === undefined ? jsonRes(200, []) : jsonRes(200, [{ sha }]);
  }
  calls.archive += 1;
  const m = /^https:\/\/codeload\.github\.com\/([^/]+\/[^/]+)\/tar\.gz\//.exec(u);
  const buf = m === null ? undefined : archives.get(m[1]);
  if (buf === undefined) return { ok: false, status: 404 };
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
};

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'x-ratelimit-remaining' ? '57' : null) },
    json: async () => body,
  };
}

/** ------------------------------------------------------------- mock DSH */

const agent = { id: 'a1', session: { header: { cwd: root } } };

const ctx = {
  get(name) {
    if (name === 'agents') return { get: () => agent, list: () => [agent] };
    if (name === 'workspaceRegistry') return { list: () => [] };
    if (name === 'subprocess') {
      return {
        resolveExecutable: async () => 'tar',
        spawn: ({ argv, cwd }) => {
          const child = execFile(argv[0], argv.slice(1), { cwd, maxBuffer: 1 << 22 }, () => {});
          let out = '';
          child.stdout.on('data', (d) => { out += String(d); });
          const collected = { stdout: { text: '' }, stderr: { text: '' } };
          const done = new Promise((settle) => child.on('close', (code) => {
            collected.stdout.text = out;
            settle({ exitCode: code, signal: null });
          }));
          return { collected, done, terminate() { child.kill(); } };
        },
      };
    }
    return undefined;
  },
  skills: {
    async list() { return []; },
    async get() { return undefined; },
  },
};

const handlers = () => createHandlers(ctx, { cacheRoot, fetch: fakeFetch });

/** Write an installed skill straight onto disk, as an install would leave it. */
async function installed(name, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(globalRoot, name, ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

const manifestPath = join(globalRoot, '.skills-panel.json');
async function writeRecord(name, record) {
  let mf = { version: 1, skills: {} };
  try { mf = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { /* first write */ }
  mf.skills[name] = record;
  await writeFile(manifestPath, JSON.stringify(mf, null, 2), 'utf8');
}
async function readRecord(name) {
  const mf = JSON.parse(await readFile(manifestPath, 'utf8'));
  return mf.skills[name];
}

/** `buildSkills` reads DSH's catalogue; these fixtures stand in for it. */
function catalogueFrom(items) {
  ctx.skills.list = async () => items.map(({ name, dir }) => ({
    name,
    description: '',
    whenToUse: undefined,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'user-dsh',
    provider: 'filesystem',
    path: join(dir, 'SKILL.md'),
    resourceBase: { kind: 'directory', path: dir },
  }));
}

/** ---------------------------------------------------------------- checks */

console.log('== a check downloads no archive at all');
await installed('alpha', { 'SKILL.md': '---\nname: alpha\ndescription: a.\n---\n\nAlpha.\n' });
repoState('acme/one', 'HEAD1', { 'skills/alpha': 'SHA-A1' });
await writeRecord('alpha', {
  source: 'acme/one',
  skillId: 'alpha',
  skillPath: 'skills/alpha/SKILL.md',
  hash: 'x',
  hashVersion: 3,
  upstreamHash: 'y',
  upstreamVersion: 1,
  repoHead: 'HEAD1',
  skillSha: 'SHA-A1',
  mode: 'install',
  at: String(Date.now()),
});
catalogueFrom([{ name: 'alpha', dir: join(globalRoot, 'alpha') }]);

let h = handlers();
calls.archive = 0;
let r = await h['check-updates']({});
ok(r.ok === true, 'the check succeeds', r.error);
ok(r.updates.alpha.status === 'current', 'an unchanged repository is current', r.updates.alpha.status);
ok(calls.archive === 0, 'zero archive requests', String(calls.archive));
ok(calls.api.length === 1, 'one request settles the whole repository', String(calls.api.length));

console.log('\n== a moved tip with an unmoved skill is still current');
repoState('acme/one', 'HEAD2', { 'skills/alpha': 'SHA-A1' });
calls.archive = 0;
r = await h['check-updates']({});
ok(r.updates.alpha.status === 'current', 'only the skill directory decides', r.updates.alpha.status);
ok(calls.archive === 0, 'still no archive', String(calls.archive));
ok(calls.api.length === 1 + 2, 'tip and directory were both asked', String(calls.api.length));
ok((await readRecord('alpha')).repoHead === 'HEAD2', 'the moved tip was recorded');

console.log('\n== a moved skill directory is an update');
repoState('acme/one', 'HEAD3', { 'skills/alpha': 'SHA-A2' });
calls.archive = 0;
r = await h['check-updates']({});
ok(r.updates.alpha.status === 'update', 'the release is reported', r.updates.alpha.status);
ok(calls.archive === 0, 'and still nothing was downloaded', String(calls.archive));
ok((await readRecord('alpha')).skillSha === 'SHA-A2', 'the new commit id was recorded');

console.log('\n== reuse is opt-in');
calls.api.length = 0;
r = await h['check-updates']({});
ok(r.cached !== true, 'a plain call asks upstream', String(r.cached));
const asked = calls.api.length;
calls.api.length = 0;
r = await h['check-updates']({ reuse: true });
ok(r.cached === true, 'reuse answers from the last result', String(r.cached));
ok(calls.api.length === 0, 'and asks nothing', String(calls.api.length));
ok(asked > 0, 'while the plain call did ask', String(asked));
calls.api.length = 0;
r = await h['check-updates']({ reuse: true, force: true });
ok(r.cached !== true && calls.api.length > 0, 'force overrides reuse', String(calls.api.length));

console.log('\n== a record with no baseline claims nothing the first time');
repoState('acme/two', 'TIP1', { 'skills/beta': 'BETA-1' });
await installed('beta', { 'SKILL.md': '---\nname: beta\ndescription: b.\n---\n\nBeta.\n' });
await writeRecord('beta', {
  source: 'acme/two',
  skillId: 'beta',
  skillPath: 'skills/beta/SKILL.md',
  hash: 'x',
  hashVersion: 3,
  mode: 'install',
  at: String(Date.now()),
});
catalogueFrom([
  { name: 'alpha', dir: join(globalRoot, 'alpha') },
  { name: 'beta', dir: join(globalRoot, 'beta') },
]);
r = await h['check-updates']({});
ok(r.updates.beta.status === 'current', 'an unbaselined record is not a release', r.updates.beta.status);
ok(r.updates.beta.rebased === true, 'it says it was re-baselined');
ok((await readRecord('beta')).skillSha === 'BETA-1', 'and the baseline is now on record');
repoState('acme/two', 'TIP2', { 'skills/beta': 'BETA-2' });
r = await h['check-updates']({});
ok(r.updates.beta.status === 'update', 'the next real release is reported', r.updates.beta.status);

console.log('\n== an unreachable API falls back to the archive');
await defineArchive('acme/three', {
  'skills/gamma/SKILL.md': '---\nname: gamma\ndescription: g.\n---\n\nGamma v1.\n',
});
await installed('gamma', { 'SKILL.md': '---\nname: gamma\ndescription: g.\n---\n\nGamma v1.\n' });
await writeRecord('gamma', {
  source: 'acme/three',
  skillId: 'gamma',
  skillPath: 'skills/gamma/SKILL.md',
  hash: 'x',
  hashVersion: 3,
  mode: 'install',
  at: String(Date.now()),
});
catalogueFrom([
  { name: 'alpha', dir: join(globalRoot, 'alpha') },
  { name: 'beta', dir: join(globalRoot, 'beta') },
  { name: 'gamma', dir: join(globalRoot, 'gamma') },
]);
apiDown = true;
calls.archive = 0;
r = await h['check-updates']({});
ok(r.updates.gamma.status === 'current', 'the archive path still answers', r.updates.gamma.status);
ok(calls.archive > 0, 'by downloading, as it must', String(calls.archive));
ok(r.fellBack === true, 'and the answer says it fell back');
ok(r.updates.alpha.status === 'unreachable', 'a skill it cannot answer for is unreachable', r.updates.alpha.status);
apiDown = false;

console.log('\n== rate limiting is reported, and does not become a download');
// Establish a good round first, so "the last good answer" is a known value.
apiDown = false;
repoState('acme/two', 'TIP3', { 'skills/beta': 'BETA-3' });
r = await h['check-updates']({ force: true });
ok(r.updates.beta.status === 'update', 'a good round records an update', JSON.stringify(r.updates.beta));
// A spent budget must not send the check back to downloading every archive: on
// the slow link this exists for, that is four and a half minutes to learn
// nothing. The last known answers stand, and the flag says why.
const limitedFetch = async (url) => {
  if (String(url).startsWith('https://api.github.com/')) {
    return { ok: false, status: 403, headers: { get: () => '0' } };
  }
  calls.archive += 1;
  return { ok: false, status: 404 };
};
calls.archive = 0;
const limited = createHandlers(ctx, { cacheRoot, fetch: limitedFetch, run: async () => ({ code: 1, out: '', err: '' }) });
r = await limited['check-updates']({});
ok(r.rateLimited === true, 'a spent budget is flagged');
ok(r.fellBack !== true, 'and it does not fall back to downloading', String(r.fellBack));
ok(calls.archive === 0, 'so no archive was requested', String(calls.archive));
// beta was last answered by the working run above ("update", since its
// directory moved), so that is what a rate-limited round has to keep showing
// rather than inventing "unreachable" for everything.
const lastKnown = JSON.parse(await readFile(manifestPath, 'utf8')).lastCheckResults;
ok(r.updates.beta.status === lastKnown.beta.status, 'the last good answer stands',
  `${JSON.stringify(r.updates.beta)} vs ${JSON.stringify(lastKnown.beta)}`);

console.log('');
if (failures.length > 0) {
  console.error(`FAILED: ${failures.length} verdict(s):\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('OK: the check is a few kilobytes of commit ids, not a download.');
void existsSync;
void resolve;
void promisify;
