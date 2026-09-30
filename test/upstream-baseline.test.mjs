/**
 * dsh-skills-panel — the update check answers for upstream, and only upstream.
 *
 * The failure this covers was reported from a machine running two DSH
 * installations — the desktop app and a `dsh web` server — against one shared
 * skills root:
 *
 *   - the desktop app had been launched before the panel was updated, so it was
 *     still executing the older host half (`hash` = a digest of SKILL.md text,
 *     no `hashVersion`), while the web server ran the newer one;
 *   - both wrote `.skills-panel.json` in that one root, so each kept rewriting
 *     the other's baseline in its own format;
 *   - the newer half re-baselined a record it could not read *from the local
 *     copy*, and the older half compared its own digest of `SKILL.md` against a
 *     whole-folder digest — so a skill reported "update available" for good,
 *     whatever upstream did, and flipping the panel's own auto/manual switch was
 *     enough to (re)produce it.
 *
 * The invariant asserted here: "has upstream moved" is decided against a
 * baseline of what upstream published, and a record another build wrote — or
 * another installation rewrote — can neither manufacture nor suppress that
 * answer. Local content, the panel's own switch included, is a separate
 * question with a separate baseline.
 *
 * `node test/upstream-baseline.test.mjs` exits non-zero on any failed verdict.
 * It runs the real `createHandlers()` against a synthetic harness home, a mocked
 * codeload and the real `tar`; nothing outside the OS temp directory is touched.
 */
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
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

/** ------------------------------------------------------------- the old halves */

/** The hash `lib/host-core.js` used before whole-folder digests (0.1.4). */
function legacySkillHash(text) {
  let h = 2166136261;
  const str = String(text).trim();
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16);
}

/** The folder digest 0.2.0 wrote: every file, SKILL.md included as bytes, so
 *  the panel's own `disable-model-invocation` counted as content. */
async function legacyFolderDigest(dir) {
  const hashText = (s) => {
    let h = 2166136261;
    const str = String(s);
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h.toString(16);
  };
  const walk = async (rel) => {
    const abs = rel === '' ? dir : join(dir, ...rel.split('/'));
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return [];
    }
    const out = [];
    for (const e of entries) {
      if (e.name === '.git') continue;
      const child = rel === '' ? e.name : rel + '/' + e.name;
      if (e.isDirectory()) out.push(...(await walk(child)));
      else out.push(child);
    }
    return out;
  };
  const files = (await walk('')).sort();
  const parts = [];
  for (const rel of files) {
    let tag = '?';
    try {
      tag = hashText((await readFile(join(dir, ...rel.split('/')))).toString('base64'));
    } catch {}
    parts.push(rel + '\u0000' + tag);
  }
  return hashText(parts.join('\n'));
}

/** ----------------------------------------------------------------- fixtures */

const root = await mkdtemp(join(tmpdir(), 'dsh-skills-panel-upstream-'));
const envHome = join(root, 'env-home');
const skillsRoot = join(envHome, 'skills');
const cacheRoot = join(root, 'cache');
await mkdir(skillsRoot, { recursive: true });
await mkdir(cacheRoot, { recursive: true });
process.env.DSH_HOME = envHome;

const repoTree = join(root, 'upstream');
const skillSrc = join(repoTree, 'skills', 'delta');
await mkdir(skillSrc, { recursive: true });
await writeFile(join(repoTree, 'README.md'), '# repo\n');

/** The repository's SKILL.md, as upstream publishes it (no panel switch). */
const upstreamSkill = (body) =>
  `---\nname: delta\ndescription: delta skill.\n---\n\n${body}\n`;

await writeFile(join(skillSrc, 'SKILL.md'), upstreamSkill('Delta body v1.'));
await writeFile(join(skillSrc, 'helper.py'), 'print("hi")\n');

const archivePath = join(root, 'delta.tgz');
let archive = await pack();

async function pack() {
  await exec('tar', ['-czf', archivePath, '-C', repoTree, '.']);
  return readFile(archivePath);
}

/** Move upstream on, and expire the extraction cache so the next read re-downloads. */
async function upstream(body) {
  await writeFile(join(skillSrc, 'SKILL.md'), upstreamSkill(body));
  archive = await pack();
  const old = new Date(Date.now() - 60 * 60 * 1000);
  for (const entry of await readdir(cacheRoot, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const meta = join(cacheRoot, entry.name, 'meta.json');
    if (existsSync(meta)) await utimes(meta, old, old);
  }
}

/** --------------------------------------------------------------- mock DSH */

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

async function catalogue(dir, source) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    let text;
    try {
      text = await readFile(join(dir, entry.name, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
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

const agent = { id: 'agent-1', session: { header: { cwd: skillsRoot } } };

const ctx = {
  get(name) {
    if (name === 'agents') return { get: () => agent, list: () => [agent] };
    if (name === 'workspaceRegistry') return { list: () => [] };
    if (name === 'settings') return { prepareDocument: async () => join(envHome, 'patch.yml') };
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
    async list() {
      return catalogue(skillsRoot, 'user-dsh');
    },
    async get(name, options = {}) {
      return (await this.list(options)).find((s) => s.name === name);
    },
  },
};

const h = createHandlers(ctx, {
  cacheRoot,
  fetch: async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
  }),
});

const manifestPath = join(skillsRoot, '.skills-panel.json');
const record = async (name) =>
  JSON.parse(await readFile(manifestPath, 'utf8')).skills[name];
const setRecord = async (name, entry) => {
  const mf = JSON.parse(await readFile(manifestPath, 'utf8'));
  mf.skills[name] = entry;
  await writeFile(manifestPath, JSON.stringify(mf, null, 2), 'utf8');
};
const localText = () => readFile(join(skillsRoot, 'delta', 'SKILL.md'), 'utf8');
const check = () => h['check-updates']({ projectPath: '' }).then((r) => r.updates.delta);

/** ------------------------------------------------------------------- run */

try {
  console.log('\n== a fresh install reads as current');
  let r = await h.install({ source: 'acme/repo', skillId: 'delta', target: 'global' });
  ok(r.ok === true, 'installed');
  ok((await check()).status === 'current', 'current with no upstream change');
  ok((await record('delta')).upstreamHash !== undefined, 'an upstream baseline was recorded');

  console.log('\n== the auto/manual switch is not content');
  ok((await h['set-enabled']({ name: 'delta', enabled: false })).ok === true, 'switched to manual');
  let v = await check();
  ok(v.status === 'current', 'a switch flip does not manufacture an update');
  ok(v.locallyModified === false, 'nor does it count as an edit');

  console.log('\n== a record written by an older build is not an update');
  // 0.1.4 shape: a digest of SKILL.md text, no hashVersion — and the copy
  // carries the panel's own flag, which is exactly the reported combination.
  const legacyText = await localText();
  await setRecord('delta', {
    source: 'acme/repo',
    skillId: 'delta',
    branch: 'HEAD',
    skillPath: 'skills/delta/SKILL.md',
    hash: legacySkillHash(legacyText),
    mode: 'install',
    at: String(Date.now()),
  });
  v = await check();
  console.log('   status:', v.status, 'rebased:', v.rebased === true);
  ok(v.status === 'current', 'a 0.1.x record does not read as an upstream release');
  ok(v.rebased === true, 'and it is reported as re-baselined');
  ok((await record('delta')).upstreamHash !== undefined, 'the upstream baseline was re-established');

  // 0.2.0 shape: a whole-folder digest that counted the flag, so the baseline
  // disagrees with a repository that does not ship it.
  await setRecord('delta', {
    source: 'acme/repo',
    skillId: 'delta',
    branch: 'HEAD',
    skillPath: 'skills/delta/SKILL.md',
    hash: await legacyFolderDigest(join(skillsRoot, 'delta')),
    hashVersion: 2,
    fileCount: 2,
    mode: 'install',
    at: String(Date.now()),
  });
  v = await check();
  console.log('   status:', v.status, 'rebased:', v.rebased === true);
  ok(v.status === 'current', 'a flag-counting baseline does not either');
  ok((await record('delta')).hashVersion !== 2, 'the local baseline was brought up to date');

  console.log('\n== another installation rewriting the record cannot move the answer');
  // What 0.2.0's own re-baseline does: it keeps fields it does not know about
  // (so `upstreamHash` survives) and rewrites `hash`/`hashVersion` in its terms.
  const kept = await record('delta');
  await setRecord('delta', Object.assign({}, kept, {
    hash: await legacyFolderDigest(join(skillsRoot, 'delta')),
    hashVersion: 2,
    rebased: true,
  }));
  v = await check();
  ok(v.status === 'current', 'a stale writer in another process does not cause an update');
  ok((await record('delta')).hashVersion !== 2, 'and the record is repaired in place');

  console.log('\n== a real upstream release is still reported');
  await upstream('Delta body v2.');
  v = await check();
  console.log('   status:', v.status);
  ok(v.status === 'update', 'the release is reported');
  const upd = await h.update({ name: 'delta', projectPath: '' });
  ok(upd.ok === true && upd.upToDate === false, 'update applies it');
  ok((await localText()).includes('Delta body v2.'), 'the copy moved to v2');
  ok((await check()).status === 'current', 'and it reads as current again');

  console.log('\n== the switch survives an update, and still is not content');
  ok((await record('delta')).upstreamHash !== undefined, 'the update recorded an upstream baseline');
  const off = await h['set-enabled']({ name: 'delta', enabled: false });
  ok(off.ok === true, 'switched to manual again');
  await upstream('Delta body v3.');
  v = await check();
  ok(v.status === 'update', 'the next release is reported with the switch off');
  const upd2 = await h.update({ name: 'delta', projectPath: '' });
  ok(upd2.ok === true, 'updated with the switch off');
  ok(/^disable-model-invocation: true$/m.test(await localText()), 'the setting was carried across');
  ok((await check()).status === 'current', 'current afterwards');

  console.log('\n== a local edit is a separate question from an upstream release');
  await writeFile(join(skillsRoot, 'delta', 'SKILL.md'),
    (await localText()).replace('Delta body v3.', 'Delta body v3, mine.'));
  v = await check();
  ok(v.status === 'current', 'editing the copy is not an upstream release');
  ok(v.locallyModified === true, 'and it is reported as a local edit');
  const idle = await h.update({ name: 'delta', projectPath: '' });
  ok(idle.ok === true && idle.upToDate === true, 'with upstream unmoved there is nothing to apply');
  ok((await localText()).includes('Delta body v3, mine.'), 'and the edit is left alone, not replaced');

  console.log('\n== an upstream release over a local edit still asks before replacing');
  await upstream('Delta body v4.');
  v = await check();
  ok(v.status === 'update', 'the release is reported');
  ok(v.locallyModified === true, 'alongside the local edit');
  const refused = await h.update({ name: 'delta', projectPath: '' });
  ok(refused.ok === false && refused.locallyModified === true, 'update asks before discarding it');
  const forced = await h.update({ name: 'delta', projectPath: '', force: true });
  ok(forced.ok === true && forced.upToDate === false, 'and forcing it applies the release');
  ok((await localText()).includes('Delta body v4.'), 'the copy moved to v4');

  console.log('\n== re-baselining costs at most one report, never all of them');
  await setRecord('delta', {
    source: 'acme/repo',
    skillId: 'delta',
    branch: 'HEAD',
    skillPath: 'skills/delta/SKILL.md',
    hash: legacySkillHash(await localText()),
    mode: 'install',
    at: String(Date.now()),
  });
  await upstream('Delta body v5.');
  v = await check();
  console.log('   status after the unreadable baseline:', v.status);
  ok(v.status === 'current', 'nothing is claimed while the baseline is unknown');
  await upstream('Delta body v6.');
  v = await check();
  console.log('   status on the release after that:', v.status);
  ok(v.status === 'update', 'and the release after it is reported, not swallowed for good');
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
