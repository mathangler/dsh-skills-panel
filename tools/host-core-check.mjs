/**
 * dsh-skills-panel — host-core check.
 *
 * Runs the real `createHandlers()` from `lib/host-core.js` against a synthetic
 * harness home, a mocked Cordis context, a mocked codeload and the real `tar`.
 * No DSH server, no browser and no shell of our own are involved, and nothing
 * outside the OS temp directory is touched.
 *
 * It covers the three failures this panel shipped with:
 *
 *   1. the global skills root. It used to come from `settings.prepareDocument()`
 *      — the *profile patch*, `<home>/profiles/web/cordis.patch.yml` — whose
 *      directory is the profile, so an install landed in
 *      `<home>/profiles/web/skills`, a path DSH never scans: the skill existed
 *      on disk and appeared in no list. The root must be the one DSH itself
 *      reports, and must never be a directory inside a profile.
 *   2. Reinstall. A search result that is already installed offers Reinstall,
 *      and the host refused it with "Something already exists at …" because the
 *      client sends no force flag. The panel's own record has to authorise
 *      replacing the folder it installed, and nothing else may be replaced.
 *   3. Check for updates. The extracted SKILL.md was memoised by source/skillId
 *      with no expiry, so once a skill had been read in a process, every later
 *      check compared that first copy — a repository change stayed invisible
 *      for the life of the server, and the Update button stayed disabled behind
 *      an "up to date" tag.
 *
 * `node tools/host-core-check.mjs` exits non-zero on any failed verdict.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHandlers } from '../lib/host-core.js';

const exec = promisify(execFile);
const failures = [];

function ok(condition, what) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${what}`);
  if (!condition) failures.push(what);
}

/** --------------------------------------------------------------- fixtures */

const root = await mkdtemp(join(tmpdir(), 'dsh-skills-panel-check-'));
const envHome = join(root, 'env-home');
/** A root only DSH's own discovery can name (`dshHome` configured elsewhere). */
const configuredRoot = join(envHome, 'configured-skills');
const profileDir = join(envHome, 'profiles', 'web');
const projectRepo = join(root, 'repo');
const projectSub = join(projectRepo, 'packages', 'app');

await mkdir(configuredRoot, { recursive: true });
await mkdir(join(envHome, 'skills'), { recursive: true });
await mkdir(profileDir, { recursive: true });
await mkdir(projectSub, { recursive: true });
await mkdir(join(projectRepo, '.git'), { recursive: true });
await writeFile(join(profileDir, 'cordis.patch.yml'), '- insert: []\n');

/** The harness home this plugin must resolve for the fallback branch. */
process.env.DSH_HOME = envHome;

const skill = (dir, name, body = 'Body.') =>
  writeFile(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill.\n---\n\n${body}\n`);

await mkdir(join(configuredRoot, 'alpha'), { recursive: true });
await skill(configuredRoot, 'alpha', 'Alpha body.');
await mkdir(join(configuredRoot, 'beta'), { recursive: true });
await skill(configuredRoot, 'beta', 'Beta body.');

/** A repository the mocked codeload serves; `upstream()` moves it on. */
const repoTree = join(root, 'upstream');
await mkdir(join(repoTree, 'skills', 'delta'), { recursive: true });
await writeFile(join(repoTree, 'skills', 'delta', 'SKILL.md'),
  '---\nname: delta\ndescription: delta skill.\n---\n\nDelta body v1.\n');
await writeFile(join(repoTree, 'skills', 'delta', 'helper.py'), 'print("hi")\n');
const archivePath = join(root, 'delta.tgz');
/** This run's own extraction cache, so a leftover tree for the same repository
 *  slug from some other run can never answer for it. */
const cacheRoot = join(root, 'cache');
await mkdir(cacheRoot, { recursive: true });
let archive = await pack();

async function pack() {
  await exec('tar', ['-czf', archivePath, '-C', repoTree, '.']);
  return readFile(archivePath);
}

/** Move the upstream copy on, and expire this run's extraction cache TTL. */
async function upstream(body) {
  await writeFile(join(repoTree, 'skills', 'delta', 'SKILL.md'),
    `---\nname: delta\ndescription: delta skill.\n---\n\n${body}\n`);
  archive = await pack();
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
  const field = (key, fallback) => {
    if (block === null) return fallback;
    const m = new RegExp('^' + key + ':[ \\t]*(.+)$', 'm').exec(block[1]);
    return m === null ? fallback : m[1].trim();
  };
  return {
    description: field('description', ''),
    disabled: /^disable-model-invocation:[ \t]*true$/m.test(block === null ? '' : block[1]),
  };
};

/** One root's skills, as DSH would report them. */
async function catalogue(dir, source) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    let text;
    try { text = await readFile(join(dir, entry.name, 'SKILL.md'), 'utf8'); } catch { continue; }
    const parsed = parse(text);
    out.push({
      name: entry.name,
      description: parsed.description,
      whenToUse: undefined,
      invocation: { modelInvocable: !parsed.disabled, userInvocable: true },
      source,
      provider: 'filesystem',
      path: join(dir, entry.name, 'SKILL.md'),
      resourceBase: { kind: 'directory', path: join(dir, entry.name) },
    });
  }
  return out;
}

/** DSH scopes a cwd to the nearest ancestor holding `.git`. */
function findProjectRoot(cwd) {
  const start = resolve(cwd);
  let current = start;
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/** `discoverRoot` stands in for DSH's own user root: it can name a directory
 *  the env override does not, and can be silenced to exercise the fallback. */
let discoverRoot = configuredRoot;

const agent = { id: 'agent-1', session: { header: { cwd: projectSub } } };

const ctx = {
  get(name) {
    if (name === 'agents') return { get: () => agent, list: () => [agent] };
    if (name === 'workspaceRegistry') {
      return { list: () => [{ id: 'workspace-1', title: 'app', path: projectSub }] };
    }
    if (name === 'settings') {
      // DSH's real answer here is the profile patch — the path that used to be
      // mistaken for the harness home.
      return { prepareDocument: async () => join(profileDir, 'cordis.patch.yml') };
    }
    if (name === 'subprocess') {
      return {
        resolveExecutable: async (n) => (await exec('which', [n])).stdout.trim(),
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
      const out = discoverRoot === null ? [] : await catalogue(discoverRoot, 'user-dsh');
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
    fetch: async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
    }),
  });

/**
 * One scenario at a time, so a broken build reports the verdict it broke on
 * instead of dying with a stack trace before the summary.
 */
async function run() {
  const profileSkills = join(profileDir, 'skills');

  /** ---------------------------------------------------------------- roots */

  console.log('\n== the global skills root is the one DSH reports');
  let h = handlers();
  let boot = await h.bootstrap();
  console.log('   globalRoot:', boot.globalRoot);
  ok(boot.globalRoot === configuredRoot, 'discovery wins over the env override (a configured dshHome is honoured)');
  ok(boot.globalRoot !== profileSkills, 'the profile directory is never the global root');
  ok(boot.projects.length === 1 && boot.projects[0].path === projectSub, 'workspace registry projects are reported');

  console.log('\n== install lands where DSH looks');
  let r = await h.install({ source: 'acme/repo', skillId: 'delta', target: 'global' });
  console.log('   dir:', r.dir);
  ok(r.ok === true && r.dir === join(configuredRoot, 'delta'), 'installed into the discovered root');
  ok(existsSync(join(configuredRoot, 'delta', 'SKILL.md')), 'SKILL.md is there');
  ok(existsSync(join(configuredRoot, 'delta', 'helper.py')), 'sibling assets came along');
  ok(!existsSync(profileSkills), 'nothing was written under the profile');
  ok((await h.list({})).installed['acme/repo/delta'] === 'install', 'the result is badged already installed');

  console.log('\n== with no global skill to discover, the fallback is the harness home');
  discoverRoot = null;
  const fallbackHandlers = handlers();
  boot = await fallbackHandlers.bootstrap();
  console.log('   globalRoot:', boot.globalRoot);
  ok(boot.globalRoot === join(envHome, 'skills'), 'falls back to $DSH_HOME/skills');
  const fallbackInstall = await fallbackHandlers.install({ source: 'acme/repo', skillId: 'delta', target: 'global' });
  ok(fallbackInstall.ok === true && fallbackInstall.dir === join(envHome, 'skills', 'delta'), 'installed into the fallback root');
  ok(!existsSync(profileSkills), 'still nothing under the profile');
  discoverRoot = configuredRoot;
  await rm(join(envHome, 'skills', 'delta'), { recursive: true, force: true });

  console.log('\n== a project install follows the repository root DSH scopes to');
  h = handlers();
  r = await h.install({ source: 'acme/repo', skillId: 'delta', target: 'project', projectPath: projectSub });
  console.log('   dir:', r.dir);
  ok(r.ok === true && r.dir === join(projectRepo, '.dsh', 'skills', 'delta'), 'installed under the .git root, not the workspace subdirectory');
  const projectList = await h.list({ projectPath: projectSub });
  ok(projectList.skills.some((s) => s.name === 'delta' && s.source === 'project-dsh'), 'and the project scope lists it back');
  await rm(join(projectRepo, '.dsh'), { recursive: true, force: true });

  /** ------------------------------------------------------------- reinstall */

  console.log('\n== Reinstall replaces what this panel installed');
  h = handlers();
  await upstream('Delta body v2.');
  const again = await h.install({ source: 'acme/repo', skillId: 'delta', target: 'global' });
  ok(again.ok === true, 'reinstall is accepted');
  ok((await readFile(join(configuredRoot, 'delta', 'SKILL.md'), 'utf8')).includes('Delta body v2.'), 'the installed copy moved to v2');
  ok((await h.list({})).installed['acme/repo/delta'] === 'install', 'still recorded as panel-installed');

  console.log('\n== a folder the panel did not install is left alone');
  await mkdir(join(configuredRoot, 'epsilon'), { recursive: true });
  await writeFile(join(configuredRoot, 'epsilon', 'SKILL.md'), '---\nname: epsilon\n---\n\nHand-written.\n');
  const foreign = await h.install({ source: 'acme/other', skillId: 'epsilon', target: 'global' });
  console.log('   error:', foreign.error);
  ok(foreign.ok === false && /already exists/.test(foreign.error), 'a foreign folder still refuses');
  ok((await readFile(join(configuredRoot, 'epsilon', 'SKILL.md'), 'utf8')).includes('Hand-written.'), 'its content was not touched');

  console.log('\n== another repository cannot replace a skill by name');
  const stolen = await h.install({ source: 'other/repo', skillId: 'delta', target: 'global' });
  ok(stolen.ok === false, 'refused: the record names a different source');

  /** -------------------------------------------------------- update checks */

  console.log('\n== check for updates sees a repository that moved on');
  let check = await h['check-updates']({ projectPath: '' });
  ok(check.updates.delta.status === 'current', 'a fresh copy is current');
  await upstream('Delta body v3.');
  check = await h['check-updates']({ projectPath: '' });
  console.log('   status:', check.updates.delta.status);
  ok(check.updates.delta.status === 'update', 'the change is reported once the archive TTL expires');

  console.log('\n== update installs it, and keeps seeing the next change');
  const upd = await h.update({ name: 'delta', projectPath: '' });
  ok(upd.ok === true && upd.upToDate === false, 'update ran');
  ok((await readFile(join(configuredRoot, 'delta', 'SKILL.md'), 'utf8')).includes('Delta body v3.'), 'the installed copy moved to v3');
  check = await h['check-updates']({ projectPath: '' });
  ok(check.updates.delta.status === 'current', 'it reads as current again');

  await upstream('Delta body v4.');
  check = await h['check-updates']({ projectPath: '' });
  console.log('   status:', check.updates.delta.status);
  ok(check.updates.delta.status === 'update', 'a second change is not masked by the first answer');

  const upd2 = await h.update({ name: 'delta', projectPath: '' });
  ok(upd2.ok === true && upd2.upToDate === false, 'the second update ran');
  ok((await readFile(join(configuredRoot, 'delta', 'SKILL.md'), 'utf8')).includes('Delta body v4.'), 'the installed copy moved to v4');

  const idle = await h.update({ name: 'delta', projectPath: '' });
  ok(idle.ok === true && idle.upToDate === true, 'an unchanged skill reports up to date instead of rewriting');

  /** ------------------------------------------------------------- toggling */

  console.log('\n== the model-context switch edits frontmatter, nothing else');
  const off = await h['set-enabled']({ name: 'delta', enabled: false });
  ok(off.ok === true, 'switched off');
  let text = await readFile(join(configuredRoot, 'delta', 'SKILL.md'), 'utf8');
  ok(/^disable-model-invocation: true$/m.test(text), 'the flag was written');
  const on = await h['set-enabled']({ name: 'delta', enabled: true });
  text = await readFile(join(configuredRoot, 'delta', 'SKILL.md'), 'utf8');
  ok(on.ok === true && !/disable-model-invocation/.test(text), 'switching back removes it');

  /** -------------------------------------------------- import / uninstall */

  console.log('\n== import by copy and by link');
  const local = join(root, 'local-skill');
  await mkdir(local, { recursive: true });
  await writeFile(join(local, 'SKILL.md'), '---\nname: zeta\ndescription: local.\n---\n\nZeta body.\n');
  const copied = await h['import-skill']({ sourcePath: local, mode: 'copy', target: 'global' });
  ok(copied.ok === true && existsSync(join(configuredRoot, 'zeta', 'SKILL.md')), 'copy import landed in the root DSH reads');
  const afterImport = await h['check-updates']({ projectPath: '' });
  ok(afterImport.updates.zeta === undefined, 'an imported skill is not checked upstream');
  const linked = await h['import-skill']({ sourcePath: local, mode: 'link', target: 'project', projectPath: projectSub });
  console.log('   dir:', linked.dir);
  ok(linked.ok === true && linked.dir === join(projectRepo, '.dsh', 'skills', 'zeta'), 'link import follows the project root too');

  console.log('\n== removal is contained, and a link is only a link');
  const gone = await h.uninstall({ name: 'zeta', projectPath: '' });
  ok(gone.ok === true && existsSync(local), 'removing the link left the source folder alone');
  const projectGone = await h.uninstall({ name: 'zeta', projectPath: projectSub });
  ok(projectGone.ok === true && !existsSync(join(projectRepo, '.dsh', 'skills', 'zeta')), 'the project link was removed');
  const manifest = JSON.parse(await readFile(join(configuredRoot, '.skills-panel.json'), 'utf8'));
  ok(manifest.skills.zeta === undefined, 'the manifest entry went with it');
  ok(manifest.skills.delta !== undefined, 'the surviving skill stayed recorded');

  /** --------------------------------------------------------------- report */
}

try {
  await run();
} catch (error) {
  failures.push('the run stopped early: ' + (error && error.message ? error.message : error));
}

await rm(root, { recursive: true, force: true });
console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} failed verdict(s):`);
  for (const f of failures) console.log('  - ' + f);
  process.exitCode = 1;
} else {
  console.log('all verdicts passed');
}
