/**
 * dsh-skills-panel — update tracking.
 *
 * Covers attaching a source to a skill the panel did not install, and the
 * whole-directory baseline that makes an update safe:
 *
 *   1. the baseline used to be the SKILL.md hash alone, so a release that only
 *      touched `scripts/` was reported as up to date. It is now a digest of the
 *      whole skill folder.
 *   2. a skill the panel never installed carries no record, so every check
 *      skipped it. There is nothing on disk to read a source from either — a
 *      folder unpacked from a tarball has no `.git` — so `adopt` takes it from
 *      the user, in two phases, and never in one.
 *   3. that record is also what lets an update notice that the local copy was
 *      edited, and ask before replacing it.
 *   4. an update must land back where the skill lives. It used to send no
 *      target, so refreshing a project-scoped skill installed a second copy
 *      into the global root.
 *
 * Same fixtures as `tools/host-core-check.mjs`: a synthetic harness home, a
 * mocked codeload serving real tarballs, and the real `tar`.
 *
 * `node test/track-source.test.mjs` exits non-zero on any failed check.
 */
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHandlers } from '../lib/host-core.js';

const exec = promisify(execFile);

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

/** --------------------------------------------------------------- fixtures */

const root = await mkdtemp(join(tmpdir(), 'dsh-skills-panel-track-'));
const envHome = join(root, 'env-home');
const globalRoot = join(envHome, 'skills');
const projectRepo = join(root, 'repo');
const projectSub = join(projectRepo, 'packages', 'app');
const cacheRoot = join(root, 'cache');

await mkdir(globalRoot, { recursive: true });
await mkdir(projectSub, { recursive: true });
await mkdir(join(projectRepo, '.git'), { recursive: true });
await mkdir(cacheRoot, { recursive: true });
process.env.DSH_HOME = envHome;

async function put(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
}

/** A repository the mocked codeload serves, as a real tarball. */
const repos = new Map();
async function define(slug, files) {
  const tree = join(root, 'upstream', slug.replace('/', '_'));
  await put(tree, files);
  repos.set(slug, tree);
  await pack(slug);
}
async function pack(slug) {
  const tree = repos.get(slug);
  const tgz = join(root, slug.replace('/', '_') + '.tgz');
  await exec('tar', ['-czf', tgz, '-C', tree, '.']);
  repos.set(slug, tree);
  archives.set(slug, await readFile(tgz));
}
const archives = new Map();

/** Move one repository on, and expire the extraction cache so it is re-read. */
async function upstream(slug, rel, content) {
  await writeFile(join(repos.get(slug), ...rel.split('/')), content, 'utf8');
  await pack(slug);
  // `ensureTree` honours a TTL, so a check right after this would otherwise be
  // answered by the tree from a moment ago and see no change at all.
  const old = new Date(Date.now() - 60 * 60 * 1000);
  for (const entry of await readdir(cacheRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const meta = join(cacheRoot, entry.name, 'meta.json');
    if (existsSync(meta)) await utimes(meta, old, old);
  }
}

/** ------------------------------------------------------------- mock DSH */

const parse = (text) => {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const m = block === null ? null : /^name:[ \t]*(.+)$/m.exec(block[1]);
  return { name: m === null ? '' : m[1].trim() };
};

async function catalogue(dir, source) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let text;
    try { text = await readFile(join(dir, entry.name, 'SKILL.md'), 'utf8'); } catch { continue; }
    out.push({
      name: entry.name,
      description: '',
      whenToUse: undefined,
      invocation: { modelInvocable: true, userInvocable: true },
      source,
      provider: 'filesystem',
      resourceBase: { kind: 'directory', path: join(dir, entry.name) },
      _declared: parse(text).name,
    });
  }
  return out;
}

function findProjectRoot(cwd) {
  const start = resolve(cwd);
  let current = start;
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = join(current, '..');
    if (resolve(parent) === resolve(current)) return start;
    current = parent;
  }
}

const agent = { id: 'agent-1', session: { header: { cwd: projectSub } } };

const ctx = {
  get(name) {
    if (name === 'agents') return { get: () => agent, list: () => [agent] };
    if (name === 'workspaceRegistry') return { list: () => [] };
    if (name === 'subprocess') {
      return {
        resolveExecutable: async () => 'tar',
        spawn: ({ argv, cwd }) => {
          const child = execFile(argv[0], argv.slice(1), { cwd, maxBuffer: 1 << 20 }, () => {});
          let out = '';
          child.stdout.on('data', (d) => { out += d; });
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
    async list(options = {}) {
      const out = await catalogue(globalRoot, 'user-dsh');
      if (options.cwd) {
        out.push(...(await catalogue(join(findProjectRoot(options.cwd), '.dsh', 'skills'), 'project-dsh')));
      }
      return out;
    },
    async get(name, options = {}) {
      return (await this.list(options)).find((s) => s.name === name);
    },
  },
};

const handlers = () =>
  createHandlers(ctx, {
    cacheRoot,
    fetch: async (url) => {
      const m = /^https:\/\/codeload\.github\.com\/([^/]+\/[^/]+)\/tar\.gz\//.exec(String(url));
      const buf = m === null ? undefined : archives.get(m[1]);
      if (buf === undefined) return { ok: false, status: 404 };
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    },
  });

const manifest = async (dir) =>
  JSON.parse(await readFile(join(dir, '.skills-panel.json'), 'utf8'));

/** ---------------------------------------------------------------- checks */

console.log('== the baseline covers the whole skill folder, not just SKILL.md');
await define('acme/one', {
  'skills/one/SKILL.md': '---\nname: one\ndescription: one skill.\n---\n\nOne body.\n',
  'skills/one/scripts/a.mjs': 'export const a = 1;\n',
});
let h = handlers();
let r = await h.install({ source: 'acme/one', skillId: 'one', target: 'global' });
check('install succeeds', r.ok === true && r.dir === join(globalRoot, 'one'), r.error);
check('the record is stamped v2', (await manifest(globalRoot)).skills.one.hashVersion === 2);
check('and counts the files it copied', (await manifest(globalRoot)).skills.one.fileCount === 2,
  String((await manifest(globalRoot)).skills.one.fileCount));

let up = await h['check-updates']({});
check('an unmoved repository is current', up.updates.one.status === 'current', up.updates.one.status);
check('and is not called locally edited', up.updates.one.locallyModified === false);

// The regression this file exists for: same SKILL.md, different script.
await upstream('acme/one', 'skills/one/scripts/a.mjs', 'export const a = 2;\n');
h = handlers();
up = await h['check-updates']({});
check('a scripts-only release is still an update', up.updates.one.status === 'update', up.updates.one.status);
check('the installed copy is untouched by the check', up.updates.one.locallyModified === false);

console.log('\n== a skill the panel did not install can be attached to a source');
await put(join(globalRoot, 'plain'), {
  'SKILL.md': '---\nname: plain\ndescription: plain skill.\n---\n\nPlain body.\n',
  'scripts/b.mjs': 'export const b = 1;\n',
});
await define('acme/plain', {
  'skills/plain/SKILL.md': '---\nname: plain\ndescription: plain skill.\n---\n\nPlain body.\n',
  'skills/plain/scripts/b.mjs': 'export const b = 1;\n',
});

h = handlers();
up = await h['check-updates']({});
check('an untracked skill is skipped entirely', up.updates.plain === undefined);

let look = await h.adopt({ name: 'plain', source: 'acme/plain', skillId: 'plain' });
check('phase one reports without writing', look.ok === true && look.needsConfirm === true, look.error);
// The tarball is packed from the repository root, and `ensureTree` takes the
// archive's first directory as its tree, so the path recorded is relative to
// that — this fixture's tree root is `skills/`.
check('phase one names what it found', look.found !== undefined && look.found.skillPath === 'plain/SKILL.md',
  look.found && look.found.skillPath);
check('phase one confirms it matches the local copy', look.matchesUpstream === true);
check('phase one left the manifest alone', (await manifest(globalRoot)).skills.plain === undefined);

let adopted = await h.adopt({ name: 'plain', source: 'acme/plain', skillId: 'plain', confirm: true });
check('phase two attaches it', adopted.ok === true && adopted.adopted === true, adopted.error);
let rec = (await manifest(globalRoot)).skills.plain;
check('the record carries the repository', rec.source === 'acme/plain');
check('the record is stamped v2 and marked adopted', rec.hashVersion === 2 && rec.adopted === true);
check('the baseline is what is on disk, so nothing is pending',
  (await h['check-updates']({})).updates.plain.status === 'current');

check('a pasted clone URL is accepted',
  (await h.adopt({ name: 'plain', source: 'https://github.com/acme/plain.git', skillId: 'plain' })).ok === true);
check('a bare word is refused', (await h.adopt({ name: 'plain', source: 'plain' })).ok === false);
check('a missing skill is refused', (await h.adopt({ name: 'nope', source: 'acme/plain' })).ok === false);

await upstream('acme/plain', 'skills/plain/scripts/b.mjs', 'export const b = 2;\n');
h = handlers();
check('an attached skill reports upstream moves',
  (await h['check-updates']({})).updates.plain.status === 'update');

console.log('\n== local edits are not discarded by an update');
await writeFile(join(globalRoot, 'plain', 'scripts', 'b.mjs'), 'export const b = 99; // mine\n', 'utf8');
h = handlers();
up = await h['check-updates']({});
check('the check flags the local edit', up.updates.plain.locallyModified === true);

const refused = await h.update({ name: 'plain' });
check('update refuses to replace it', refused.ok === false && refused.locallyModified === true,
  JSON.stringify(refused));
check('the local edit is still there',
  (await readFile(join(globalRoot, 'plain', 'scripts', 'b.mjs'), 'utf8')).includes('mine'));

const forced = await h.update({ name: 'plain', force: true });
check('update proceeds once confirmed', forced.ok === true, forced.error);
check('it reports having replaced local work', forced.replacedLocalChanges === true);
check('the edit is gone', !(await readFile(join(globalRoot, 'plain', 'scripts', 'b.mjs'), 'utf8')).includes('mine'));
check('and it is current again', (await h['check-updates']({})).updates.plain.status === 'current');

await writeFile(join(globalRoot, 'plain', 'scripts', 'b.mjs'), 'export const b = 42; // keep\n', 'utf8');
h = handlers();
const noop = await h.update({ name: 'plain' });
check('with no upstream change an update does nothing at all',
  noop.ok === true && noop.upToDate === true, JSON.stringify(noop));
check('and leaves the local edit alone',
  (await readFile(join(globalRoot, 'plain', 'scripts', 'b.mjs'), 'utf8')).includes('keep'));

console.log('\n== an update lands back where the skill lives');
await define('acme/proj', { 'skills/proj/SKILL.md': '---\nname: proj\ndescription: proj skill.\n---\n\nProj v1.\n' });
h = handlers();
r = await h.install({ source: 'acme/proj', skillId: 'proj', target: 'project', projectPath: projectSub });
const projectRoot = join(projectRepo, '.dsh', 'skills');
check('a project install lands under the repository root', r.ok === true && r.dir === join(projectRoot, 'proj'), r.error);

await upstream('acme/proj', 'skills/proj/SKILL.md',
  '---\nname: proj\ndescription: proj skill.\n---\n\nProj v2.\n');
h = handlers();
const moved = await h.update({ name: 'proj', projectPath: projectSub });
check('the project skill updates in place', moved.ok === true && moved.dir === join(projectRoot, 'proj'), moved.error);
check('no second copy appeared in the global root', !existsSync(join(globalRoot, 'proj')));

console.log('\n== a record from an older version is re-baselined once');
const mf = await manifest(globalRoot);
mf.skills.one = {
  source: 'acme/one',
  skillId: 'one',
  branch: 'HEAD',
  skillPath: 'skills/one/SKILL.md',
  hash: 'deadbeef',
  mode: 'install',
  at: String(Date.now()),
};
await writeFile(join(globalRoot, '.skills-panel.json'), JSON.stringify(mf, null, 2), 'utf8');

h = handlers();
up = await h['check-updates']({});
rec = (await manifest(globalRoot)).skills.one;
check('the old record is upgraded', rec.hashVersion === 2, String(rec.hashVersion));
check('it is marked re-baselined', rec.rebased === true);
check('the stale SKILL.md hash is gone', rec.hash !== 'deadbeef');
check('the copy now counts as unmodified', up.updates.one.locallyModified === false);

console.log('');
if (failed.length > 0) {
  console.error('FAILED: ' + failed.length + ' of ' + (passed + failed.length) + ': ' + failed.join('; '));
  process.exit(1);
}
console.log('OK: ' + passed + ' checks — whole-folder baseline, attach, edit guard, in-place update, migration.');
