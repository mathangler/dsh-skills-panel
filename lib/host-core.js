/**
 * Transport-free host logic for the DSH skills panel.
 *
 * Every function here talks only to Cordis services and Node builtins, never to
 * a client. `lib/index.js` adapts this map onto the Connection RPC channel.
 *
 * Cross-platform by construction: the whole repository pipeline runs in Node —
 * `fetch` for the archive, `tar` for extraction, `fs.cp` for the copy, and
 * `fs.symlink` for links. There is no shell, no PowerShell and no `curl`, so
 * Windows, macOS and Linux take the same code path. `tar` is the only external
 * tool, and it ships with all three platforms.
 *
 * @module dsh-skills-panel/host-core
 */

import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const errMsg = (e) => String(e && e.message ? e.message : e);

/** Per-skill record file, written into whichever skills root owns the skill. */
const MANIFEST = '.skills-panel.json';

/** How long an extracted repository tree may be reused before re-downloading. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Archive refs tried in order. codeload accepts `HEAD`, which removes the need
 * for `git ls-remote`; the named branches are the fallback.
 */
const REFS = ['HEAD', 'main', 'master'];

/** Depth bound for the skill-directory search, so a pathological repo cannot hang. */
const MAX_SEARCH_DEPTH = 6;

/** ---------------------------------------------------------------- text utils */

/**
 * FNV-1a over UTF-16 code units.
 *
 * Used only to notice that a skill changed, never as a security check, so a
 * fast non-cryptographic hash is the right trade.
 */
function hashText(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16);
}

/** Digest format of a record's own copy (`hash`). v1 hashed SKILL.md alone; v2
 *  did not exclude the panel's own model-invocation flag. */
const DIGEST_VERSION = 3;

/**
 * Digest format of a record's upstream baseline (`upstreamHash`).
 *
 * Its own marker rather than a second use of `DIGEST_VERSION`, because the two
 * digests answer two different questions and have to be free to move apart: a
 * change to how the local copy is digested says nothing about a baseline of
 * what upstream published, and rebuilding one must never silently invalidate
 * the other.
 */
const UPSTREAM_VERSION = 1;

/**
 * Where the cheap update check asks its question.
 *
 * Answering "has upstream moved?" does not need the content: the repository
 * publishes a commit id for every path, and comparing that id is a few
 * kilobytes of JSON instead of a multi-megabyte archive. On the slow link this
 * change exists for, checking eight repositories went from 26.8 MB and about
 * four and a half minutes to roughly 40 KB and a couple of seconds.
 */
const API_BASE = 'https://api.github.com';

/** Deadline for one API call. The check is meant to be quick or give up. */
const API_TIMEOUT_MS = 20000;

/**
 * How long a check result stands before upstream is asked again.
 *
 * Unauthenticated GitHub allows 60 requests an hour. A check costs one request
 * per repository, so with eight repositories a ten-minute floor keeps a page
 * that is left open all day inside that budget. A `GITHUB_TOKEN` or `GH_TOKEN`
 * in the environment raises the ceiling to 5000 and this floor stops mattering.
 */
const MIN_CHECK_MS = 10 * 60 * 1000;

/** The `disable-model-invocation` state of a SKILL.md: true, false, or null. */
function disableFlagOf(text) {
  const m = /^disable-model-invocation[ \t]*:[ \t]*(\S+)/m.exec(String(text));
  return m === null ? null : m[1].toLowerCase() === 'true';
}

/**
 * A SKILL.md with the invocation flag line removed, for digesting.
 *
 * That one field is written by this panel's own switch, so digesting it as
 * content made flipping a switch look like editing the skill — and a baseline
 * captured while the flag was set disagreed for good with every repository that
 * does not ship it, which read as a permanent, unapplicable update.
 */
function withoutDisableFlag(text) {
  return String(text).replace(/^disable-model-invocation[ \t]*:[^\n]*\r?\n?/m, '');
}

/**
 * One digest covering every file in a skill directory.
 *
 * Comparison used to hash SKILL.md alone, so a release that only touched
 * `scripts/` was invisible: the panel reported "up to date" for a skill that had
 * genuinely changed upstream. This covers the whole directory instead.
 *
 * Deterministic across platforms: paths are relative and separator-normalised
 * to `/`, the list is sorted, and contents are hashed as base64 so binary assets
 * count too. `.git` is skipped — it churns without the skill changing.
 *
 * @param dir - absolute path of the skill directory.
 * @returns `{ hash, files }`; an unreadable directory yields an empty hash.
 */
async function dirDigest(dir) {
  const walk = async (rel) => {
    const abs = rel === '' ? dir : join(dir, ...rel.split('/'));
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (e) {
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
      const buf = await readFile(join(dir, ...rel.split('/')));
      // The skill's own document is digested without the flag this panel's
      // switch owns; every other file is digested as bytes.
      tag = rel === 'SKILL.md'
        ? hashText(withoutDisableFlag(buf.toString('utf8')))
        : hashText(buf.toString('base64'));
    } catch (e) {
      /* unreadable entries still contribute their name, so they cannot hide */
    }
    parts.push(rel + '\u0000' + tag);
  }
  return { hash: hashText(parts.join('\n')), files };
}

/** The YAML frontmatter body of a SKILL.md, or null when absent. */
function fmBlock(c) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(c));
  return m === null ? null : m[1];
}

/** One scalar frontmatter value, with surrounding quotes stripped. */
function fmValue(block, key) {
  if (block === null) return '';
  const m = new RegExp('^' + key + ':[ \\t]*(.+)$', 'm').exec(block);
  if (!m) return '';
  let v = m[1].trim();
  if (v.length > 1 && (v.charAt(0) === '"' || v.charAt(0) === String.fromCharCode(39))) {
    v = v.slice(1, v.length - 1);
  }
  return v;
}

/** Frontmatter `name`, falling back when it is absent or not a valid slug. */
function parseSkillName(c, fb) {
  const v = fmValue(fmBlock(c), 'name');
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v) ? v : fb;
}

/**
 * Add or remove `disable-model-invocation` in a SKILL.md's frontmatter.
 *
 * This is DSH's own mechanism: a skill carrying the flag stays invocable as
 * `/name` but drops out of the model-visible catalog.
 *
 * @returns the rewritten document, or null when there is no frontmatter.
 */
function withDisableFlag(text, disable) {
  const m = /^(---\r?\n)([\s\S]*?)(\r?\n---[ \t]*)/.exec(String(text));
  if (!m) return null;
  const lines = m[2].split(/\r?\n/).filter((l) => !/^disable-model-invocation[ \t]*:/.test(l));
  if (disable === true) lines.push('disable-model-invocation: true');
  return m[1] + lines.join('\n') + m[3] + String(text).slice(m[0].length);
}

/** Filesystem-safe directory name for an `owner/repo` source. */
function slugOf(source) {
  return String(source).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'repo';
}

/** ------------------------------------------------------------ archive pipeline */

/**
 * Pick the directory inside an extracted repository that is the skill.
 *
 * Prefers a directory whose basename equals the skill id, then the repository
 * root, then the shallowest match — the precedence the previous PowerShell
 * implementation used, minus the shell.
 *
 * @returns `{ abs, rel }` or null when no directory holds a SKILL.md.
 */
async function findSkillDir(root, skillId) {
  const matches = [];

  const walk = async (abs, rel, depth) => {
    if (depth > MAX_SEARCH_DEPTH) return;
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch (e) {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      matches.push({ abs, rel, depth, named: basename(abs) === skillId });
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === '.git' || e.name === 'node_modules') continue;
      await walk(join(abs, e.name), rel === '' ? e.name : rel + '/' + e.name, depth + 1);
    }
  };

  await walk(root, '', 0);
  if (matches.length === 0) return null;

  const named = matches.filter((m) => m.named);
  if (named.length > 0) {
    named.sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel));
    return { abs: named[0].abs, rel: named[0].rel };
  }

  const atRoot = matches.filter((m) => m.rel === '');
  if (atRoot.length > 0) return { abs: atRoot[0].abs, rel: '' };

  matches.sort((a, b) => a.depth - b.depth || a.rel.localeCompare(b.rel));
  return { abs: matches[0].abs, rel: matches[0].rel };
}

/**
 * Build the panel's host-side method map.
 *
 * @param ctx - the Cordis context of the mounted plugin row.
 * @param options.platform - override `process.platform` (link type); tests only.
 * @param options.run - override the subprocess runner; tests only.
 * @param options.fetch - override the archive fetcher; tests only.
 * @param options.cacheRoot - override the extraction cache directory; tests only.
 * @returns plain async functions, one per client-callable method. Every one
 *   resolves to JSON-safe data; none throws, so a failure surfaces in the UI
 *   instead of tearing down the transport.
 */
export function createHandlers(ctx, options = {}) {
  const platform = options.platform || process.platform;
  const fetcher = options.fetch || ((url, init) => fetch(url, init));

  const docCache = {};
  let cacheRootPath = options.cacheRoot || null;
  let tarPath = null;
  let queue = Promise.resolve();

  /**
   * Serialize archive work.
   *
   * Descriptions, previews, update checks and installs all drive the same
   * extraction cache; letting two of them run at once would race on the
   * download directory.
   */
  function withLock(fn) {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Spawn a process through the DSH subprocess service and collect its output. */
  async function run(argv, cwd) {
    const sp = ctx.get('subprocess');
    if (sp === undefined) return { code: null, out: '', err: 'no subprocess service' };
    try {
      const h = sp.spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 131072 }, stderr: { maxBytes: 131072 } },
        graceMs: 300000,
      });
      const outcome = await h.done;
      let out = '';
      let err = '';
      try {
        if (h.collected && h.collected.stdout) out = String(h.collected.stdout.readFrom(0).text || '').trim();
      } catch (e) {
        /* partial output is still usable */
      }
      try {
        if (h.collected && h.collected.stderr) err = String(h.collected.stderr.readFrom(0).text || '').trim();
      } catch (e) {
        /* stderr is diagnostics only */
      }
      return {
        code: outcome === undefined || outcome.exitCode === null ? null : outcome.exitCode,
        out,
        err,
      };
    } catch (e) {
      return { code: null, out: '', err: errMsg(e) };
    }
  }

  const runner = options.run || run;

  /** Locate `tar`, the one external tool this plugin needs. */
  async function resolveTar() {
    if (tarPath !== null) return tarPath;
    const sp = ctx.get('subprocess');
    const names = platform === 'win32' ? ['tar.exe', 'tar'] : ['tar'];
    if (sp !== undefined) {
      for (const n of names) {
        try {
          const p = await sp.resolveExecutable(n);
          if (p) {
            tarPath = p;
            return tarPath;
          }
        } catch (e) {
          /* try the next candidate */
        }
      }
    }
    tarPath = names[names.length - 1];
    return tarPath;
  }

  /** Root of the extraction cache. System temp keeps it out of the DSH home. */
  async function cacheRoot() {
    if (cacheRootPath !== null) return cacheRootPath;
    const dir = join(tmpdir(), 'dsh-skills-panel');
    await mkdir(dir, { recursive: true });
    cacheRootPath = dir;
    return cacheRootPath;
  }

  /** Drop cache entries older than the TTL so the temp directory cannot grow unbounded. */
  async function pruneCache(base) {
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch (e) {
      return;
    }
    const now = Date.now();
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const st = await stat(join(base, e.name));
        if (now - st.mtimeMs > CACHE_TTL_MS) {
          await rm(join(base, e.name), { recursive: true, force: true });
        }
      } catch (err) {
        /* best effort */
      }
    }
  }

  /**
   * Ensure an extracted repository tree for `source`, downloading it if needed.
   *
   * `at` is the tree's generation stamp — the moment its meta record was
   * written, which is also what the TTL is measured from. Anything derived from
   * the tree (see `fetchDoc`) is only valid for the generation it was read in.
   *
   * @returns `{ root, branch, at }` or `{ error }`.
   */
  async function ensureTree(source) {
    const base = await cacheRoot();
    await pruneCache(base);
    const dir = join(base, slugOf(source));
    const metaPath = join(dir, 'meta.json');

    try {
      const meta = JSON.parse(await readFile(metaPath, 'utf8'));
      const st = await stat(metaPath);
      if (Date.now() - st.mtimeMs < CACHE_TTL_MS) {
        const rootStat = await stat(meta.root);
        if (rootStat.isDirectory()) return { root: meta.root, branch: meta.branch, at: st.mtimeMs };
      }
    } catch (e) {
      /* cache miss: rebuild below */
    }

    // Build the new tree beside the live one and swap it in, instead of
    // extracting over a directory another process may already be reading. Two
    // DSH installations share this temp cache, and a half-written tree digested
    // as content would be reported as an upstream release.
    const staging = dir + '.staging-' + String(process.pid) + '-'
      + Math.random().toString(36).slice(2);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    const tgz = join(staging, 'repo.tgz');
    const xdir = join(staging, 'x');
    let lastError = '';

    for (const ref of REFS) {
      let res;
      try {
        res = await fetcher('https://codeload.github.com/' + source + '/tar.gz/' + ref, {
          redirect: 'follow',
        });
      } catch (e) {
        lastError = 'could not reach codeload for ' + source + ': ' + errMsg(e);
        continue;
      }
      if (!res || !res.ok) {
        lastError = 'codeload returned HTTP ' + (res ? res.status : '?') + ' for ref ' + ref;
        continue;
      }

      let buf;
      try {
        buf = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        lastError = 'could not read the archive body: ' + errMsg(e);
        continue;
      }
      if (buf.length < 200) {
        lastError = 'the archive for ref ' + ref + ' was only ' + buf.length + ' bytes';
        continue;
      }

      try {
        await writeFile(tgz, buf);
        await rm(xdir, { recursive: true, force: true });
        await mkdir(xdir, { recursive: true });
      } catch (e) {
        lastError = 'could not stage the download: ' + errMsg(e);
        continue;
      }

      const r = await runner([await resolveTar(), '-xzf', tgz, '-C', xdir], staging);
      if (r.code !== 0) {
        lastError = 'tar failed (' + String(r.code) + '): ' + (r.err || r.out || 'no output');
        continue;
      }

      let tops;
      try {
        tops = (await readdir(xdir, { withFileTypes: true })).filter((e) => e.isDirectory());
      } catch (e) {
        lastError = 'could not read the extracted tree: ' + errMsg(e);
        continue;
      }
      if (tops.length === 0) {
        lastError = 'the archive contained no directory';
        continue;
      }

      // The stamp is the meta file's mtime, because that is the clock the TTL
      // reads; `rename` carries it, so it is read before the swap.
      await writeFile(join(staging, 'meta.json'),
        JSON.stringify({ branch: ref, root: join(dir, 'x', tops[0].name), at: Date.now() }));
      const stamp = await stat(join(staging, 'meta.json'));

      // The swap itself. A reader that resolved the previous tree a moment ago
      // finds it gone and reads nothing — which is reported as unreachable, not
      // as a change — rather than a directory that is half extracted.
      try {
        await rm(dir, { recursive: true, force: true });
        await rename(staging, dir);
      } catch (e) {
        lastError = 'could not stage the extracted tree: ' + errMsg(e);
        continue;
      }
      return { root: join(dir, 'x', tops[0].name), branch: ref, at: stamp.mtimeMs };
    }

    await rm(staging, { recursive: true, force: true });
    return { error: lastError || 'could not download the repository archive' };
  }

  /** Read a skill's SKILL.md straight out of the repository archive. */
  async function fetchDoc(source, skillId) {
    const key = source + '/' + skillId;

    const tree = await ensureTree(source);
    if (tree.error !== undefined) return { error: tree.error };

    // The memo is only as good as the generation it was read from. A tree the
    // TTL has just replaced must never answer with its predecessor's copy:
    // that re-download exists precisely to see what the repository says now,
    // and a memo that outlives the tree makes "check for updates" report the
    // first answer it ever got for as long as this process lives.
    const memo = docCache[key];
    if (memo !== undefined && memo.at === tree.at) return memo.value;

    const found = await findSkillDir(tree.root, skillId);
    if (found === null) return { error: 'no SKILL.md found for "' + skillId + '" in ' + source };

    let content;
    try {
      content = await readFile(join(found.abs, 'SKILL.md'), 'utf8');
    } catch (e) {
      return { error: 'could not read SKILL.md: ' + errMsg(e) };
    }

    const out = {
      ok: true,
      name: parseSkillName(content, skillId),
      rel: found.rel,
      branch: tree.branch,
      content,
      dir: found.abs,
    };
    docCache[key] = { at: tree.at, value: out };
    return out;
  }

  /** -------------------------------------------------------------- skill state */

  /** Resolve the Agent that scopes skill discovery, preferring the caller's session. */
  function resolveAgent(sessionId) {
    const agents = ctx.get('agents');
    if (agents === undefined) return undefined;
    if (sessionId) {
      try {
        const a = agents.get(sessionId);
        if (a !== undefined) return a;
      } catch (e) {
        /* fall through to the first live agent */
      }
    }
    try {
      const l = agents.list();
      return l.length > 0 ? l[0] : undefined;
    } catch (e) {
      return undefined;
    }
  }

  let cachedGlobalRoot;
  let globalRootPending;

  /** Expand a leading `~` the way the harness does, so an override can use it. */
  function expandHomePath(p) {
    if (p === '~') return homedir();
    if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
    return p;
  }

  /**
   * The harness home, resolved by the harness's own rule: `$DSH_HOME` (a blank
   * value counts as unset), else `~/.dsh`.
   *
   * A home that does not exist is reported as unknown rather than invented: the
   * composition may keep its data somewhere this plugin cannot name, and a
   * guessed path is how an install ends up in a directory nothing ever reads.
   *
   * @returns the home directory, or undefined when there is none to name.
   */
  async function harnessHome() {
    const env = process.env.DSH_HOME;
    const configured = env !== undefined && env.trim() !== '' ? env.trim() : join(homedir(), '.dsh');
    const home = resolve(expandHomePath(configured));
    try {
      return (await stat(home)).isDirectory() ? home : undefined;
    } catch (e) {
      return undefined;
    }
  }

  /**
   * The global skills root: the directory DSH itself reads user skills from.
   *
   * Discovery wins, because it names the root the running composition actually
   * scans — a `user-dsh` skill's own directory is that root. Only when nothing
   * is installed yet does this fall back to the harness home, which is where
   * `dsh-skill-filesystem` puts its `user-dsh` root.
   *
   * `settings.prepareDocument()` is deliberately not consulted: that document is
   * the *profile patch* (`<home>/profiles/<name>/cordis.patch.yml`), so its
   * directory is the profile. Joining `skills` onto it yielded
   * `<home>/profiles/<name>/skills`, a path DSH never scans — an install there
   * landed on disk and then appeared in no skill list at all.
   */
  async function computeGlobalRoot() {
    const agent = resolveAgent();
    if (agent !== undefined) {
      try {
        const list = await ctx.skills.list({ scope: agent });
        for (const s of list) {
          const b = s.resourceBase;
          if (String(s.source) === 'user-dsh' && b && b.kind === 'directory' && b.path) {
            return dirname(String(b.path));
          }
        }
      } catch (e) {
        /* fall through to the harness home */
      }
    }
    const home = await harnessHome();
    return home === undefined ? undefined : join(home, 'skills');
  }

  /**
   * The project root DSH scopes a cwd to: the nearest ancestor holding a `.git`
   * entry, else the cwd itself. Mirrors `dsh-skill-filesystem`'s project
   * discovery, so a project install lands in the very `.dsh/skills` the panel
   * then lists — a workspace opened below its repository root would otherwise
   * install beside the skills DSH reads instead of into them.
   */
  async function projectRoot(cwd) {
    const start = resolve(cwd);
    let current = start;
    for (;;) {
      if (await exists(join(current, '.git'))) return current;
      const parent = dirname(current);
      if (parent === current) return start;
      current = parent;
    }
  }

  async function globalRoot() {
    if (cachedGlobalRoot !== undefined) return cachedGlobalRoot;
    if (globalRootPending === undefined) globalRootPending = computeGlobalRoot();
    const value = await globalRootPending;
    globalRootPending = undefined;
    if (value !== undefined) cachedGlobalRoot = value;
    return value;
  }

  async function readManifest(root) {
    const empty = { version: 1, skills: {} };
    try {
      const data = JSON.parse(await readFile(join(root, MANIFEST), 'utf8'));
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return empty;
      if (data.skills === null || typeof data.skills !== 'object' || Array.isArray(data.skills)) {
        data.skills = {};
      }
      return data;
    } catch (e) {
      return empty;
    }
  }

  async function writeManifest(root, data) {
    await writeFile(join(root, MANIFEST), JSON.stringify(data, null, 2), 'utf8');
  }

  /** A record's baseline for "has this copy been edited", or null when this
   *  build cannot read the digest that recorded it. */
  function localBaselineOf(entry) {
    if (String(entry.hashVersion) !== String(DIGEST_VERSION)) return null;
    return typeof entry.hash === 'string' && entry.hash !== '' ? entry.hash : null;
  }

  /** A record's baseline for "has upstream moved", or null when it predates the
   *  field. Only an upstream digest is ever written here. */
  function upstreamBaselineOf(entry) {
    if (String(entry.upstreamVersion) !== String(UPSTREAM_VERSION)) return null;
    return typeof entry.upstreamHash === 'string' && entry.upstreamHash !== ''
      ? entry.upstreamHash
      : null;
  }

  /**
   * Answer this record's two questions against the repository copy just read.
   *
   * The two questions have two baselines on purpose. `hash` covers the copy on
   * disk, and `upstreamHash` covers what upstream published when that copy was
   * installed. One digest doing both jobs is what let something purely local —
   * this panel's own auto/manual switch, or a hand edit — read as an upstream
   * release, and what let two installations sharing one skills root rewrite each
   * other's baseline in incompatible formats and then report a permanent
   * "update available" that updating could never clear.
   *
   * A record that has no readable upstream baseline is re-baselined from
   * upstream, and answers "current" for this round: nothing is claimed that
   * cannot be compared. The one shortcut is a copy this panel installed and
   * nothing has edited since — that copy *is* what upstream published, so a
   * difference against it is a real release and is reported as one.
   *
   * @param root - the skills root owning the record.
   * @param name - the skill's name.
   * @param entry - the record as read.
   * @param dir - absolute path of the installed copy.
   * @param upstreamHash - digest of the repository's copy, read just now.
   * @returns `{ status, locallyModified, rebased }`.
   */
  async function compareWithUpstream(root, name, entry, dir, upstreamHash) {
    const local = await dirDigest(dir);
    const localBase = localBaselineOf(entry);
    const upstreamBase = upstreamBaselineOf(entry);
    const edited = localBase === null ? null : local.hash !== localBase;

    let next = entry;
    let status;

    if (upstreamBase !== null) {
      // The ordinary case: one question, one upstream baseline.
      status = upstreamHash === upstreamBase ? 'current' : 'update';
    } else if (edited === false) {
      // Unedited and installed by this panel, so the copy is upstream's content
      // and can stand in for the baseline it should have had.
      next = Object.assign({}, entry, {
        upstreamHash: local.hash,
        upstreamVersion: UPSTREAM_VERSION,
        upstreamAt: String(Date.now()),
      });
      status = upstreamHash === local.hash ? 'current' : 'update';
    } else {
      // The copy was edited, or its digest was written by a different build and
      // cannot be read here. Take upstream as the baseline and claim nothing:
      // the alternative is the permanent false "update" this shape exists to
      // avoid.
      next = Object.assign({}, entry, {
        upstreamHash,
        upstreamVersion: UPSTREAM_VERSION,
        upstreamAt: String(Date.now()),
      });
      status = 'current';
    }

    if (localBase === null) {
      // Whatever wrote this digest wrote it to other rules; re-record it so
      // later rounds can compare local content again.
      next = Object.assign({}, next, {
        hash: local.hash,
        hashVersion: DIGEST_VERSION,
        fileCount: local.files.length,
        rebased: true,
      });
    }

    if (next !== entry) {
      const mf = await readManifest(root);
      mf.skills[name] = next;
      await writeManifest(root, mf);
    }

    return {
      status,
      locallyModified: localBase === null ? false : local.hash !== localBase,
      rebased: next !== entry,
    };
  }

  /**
   * Check every tracked skill recorded in one skills root.
   *
   * Three tiers, cheapest first:
   *
   *   1. one request per repository asks for its default-branch tip. If it
   *      matches what the record was last checked against, nothing in that
   *      repository can have moved and every skill inside it is settled.
   *   2. for a repository that did move, one request per skill asks for the last
   *      commit touching that skill's own directory.
   *   3. only when api.github.com cannot answer at all does the old
   *      archive-comparison path run, which is slow but still correct.
   *
   * The record keeps the two commit ids it was checked against, so tier 1 and
   * tier 2 both compare against what this installation last saw rather than
   * against anything derived from local content.
   *
   * @param root - the skills root owning `mf`.
   * @param mf - that root's manifest, already read.
   * @param list - the installed skills DSH reports for this root.
   * @returns `{ updates, checkedAt, rateLimited, fellBack }`.
   */
  async function checkRoot(root, mf, list) {
    const updates = {};
    const byRepo = new Map();
    const viaArchive = [];

    for (const s of list) {
      const e = mf.skills[s.name];
      if (e === undefined || e === null || typeof e !== 'object') {
        updates[s.name] = { status: 'no-record' };
        continue;
      }
      const parts = splitSource(e.source);
      if (parts === null) {
        // Not a GitHub source at all; the archive path is the only answer.
        viaArchive.push({ s, e });
        continue;
      }
      const key = parts.owner + '/' + parts.repo;
      if (!byRepo.has(key)) byRepo.set(key, []);
      byRepo.get(key).push({ s, e });
    }

    const repoKeys = [...byRepo.keys()];
    const heads = await Promise.all(repoKeys.map((k) => commitShaAt(k, '')));

    // "Has this copy been edited?" is answered from local bytes alone, so it
    // needs no request — but a skill can be tens of megabytes, so the digests
    // run together rather than one after another.
    const editFlags = new Map();
    await Promise.all(list.map(async (s) => {
      const e = mf.skills[s.name];
      if (e === undefined || e === null || typeof e !== 'object') return;
      try {
        editFlags.set(s.name, await localEditFlag(e, String(s.dir)));
      } catch (err) {
        editFlags.set(s.name, null);
      }
    }));
    const editedFor = (name) => {
      const v = editFlags.get(name);
      return v === undefined || v === null ? false : v;
    };

    let rateLimited = false;
    let fellBack = viaArchive.length > 0;
    const moved = [];

    for (let i = 0; i < repoKeys.length; i += 1) {
      const repo = repoKeys[i];
      const items = byRepo.get(repo);
      const head = heads[i];

      if (!head.ok) {
        // A spent request budget is not a reason to start downloading tens of
        // megabytes instead: that is the slowness this check exists to remove.
        // Report it, and keep whatever the last good check said.
        if (head.rateLimited === true) {
          rateLimited = true;
          for (const it of items) {
            const prev = mf.lastCheckResults && mf.lastCheckResults[it.s.name];
            updates[it.s.name] = prev !== undefined && prev !== null
              ? prev
              : { status: 'unreachable', reason: 'rate-limited' };
          }
          continue;
        }
        for (const it of items) viaArchive.push(it);
        continue;
      }

      // The tip is unchanged and both ids are on record: nothing inside this
      // repository can have moved, so no second request is needed.
      const settled = items.every((it) => String(it.e.repoHead === undefined ? '' : it.e.repoHead) === head.sha
        && (skillDirOf(it.e) === '' || String(it.e.skillSha === undefined ? '' : it.e.skillSha) !== ''));
      if (settled) {
        for (const it of items) {
          updates[it.s.name] = { status: 'current', locallyModified: editedFor(it.s.name) };
        }
        continue;
      }

      moved.push({ repo, items, headSha: head.sha });
    }

    // Tier 2: ask for each moved skill's own directory, all at once.
    const pathResults = await Promise.all(moved.map(({ repo, items }) => Promise.all(
      items.map((it) => {
        const dir = skillDirOf(it.e);
        return dir === '' ? Promise.resolve({ ok: true, sha: '' }) : commitShaAt(repo, dir);
      }),
    )));

    /** Record patches applied to a freshly read manifest at the end. */
    const patches = {};

    for (let i = 0; i < moved.length; i += 1) {
      const { items, headSha } = moved[i];
      const results = pathResults[i];

      for (let j = 0; j < items.length; j += 1) {
        const { s, e } = items[j];
        const r = results[j];

        if (!r.ok) {
          if (r.rateLimited === true) {
            rateLimited = true;
            const prev = mf.lastCheckResults && mf.lastCheckResults[s.name];
            updates[s.name] = prev !== undefined && prev !== null
              ? prev
              : { status: 'unreachable', reason: 'rate-limited' };
            continue;
          }
          viaArchive.push({ s, e });
          continue;
        }

        // A repository-root skill has no directory of its own, so the tip is
        // its commit id by construction.
        const sha = r.sha === '' ? headSha : r.sha;
        const prev = String(e.skillSha === undefined ? '' : e.skillSha);

        let status;
        if (prev === '') {
          // No baseline of what this skill was installed at, so there is
          // nothing to compare and nothing is claimed this round.
          status = 'current';
        } else {
          status = prev === sha ? 'current' : 'update';
        }

        updates[s.name] = {
          status,
          locallyModified: editedFor(s.name),
          ...(prev === '' ? { rebased: true } : {}),
        };
        patches[s.name] = { repoHead: headSha, skillSha: sha, upstreamCheckedAt: String(Date.now()) };
      }
    }

    // Tier 3: repositories the API could not answer for.
    for (const { s, e } of viaArchive) {
      fellBack = true;
      try {
        const d = await fetchDoc(String(e.source), String(e.skillId));
        if (!d.ok) {
          updates[s.name] = { status: 'unreachable' };
          continue;
        }
        const up = await dirDigest(String(d.dir));
        if (up.files.length === 0) {
          // The extracted tree went away between locating the skill and reading
          // it. An empty read is not an answer, and recording it as upstream's
          // baseline would invent an update that never happened.
          updates[s.name] = { status: 'unreachable' };
          continue;
        }
        const verdict = await compareWithUpstream(root, s.name, e, String(s.dir), up.hash);
        updates[s.name] = {
          status: verdict.status,
          locallyModified: verdict.locallyModified,
          ...(verdict.rebased ? { rebased: true } : {}),
        };
      } catch (err) {
        updates[s.name] = { status: 'unreachable' };
      }
    }

    // `compareWithUpstream` writes the manifest itself, so the commit ids are
    // merged into a fresh read rather than a stale copy.
    const now = String(Date.now());
    const fresh = await readManifest(root);
    for (const name in patches) {
      if (fresh.skills[name] === undefined) continue;
      fresh.skills[name] = Object.assign({}, fresh.skills[name], patches[name]);
    }
    fresh.lastCheckAt = now;
    fresh.lastCheckResults = updates;
    await writeManifest(root, fresh);

    return { updates, checkedAt: Number(now), rateLimited, fellBack };
  }

  /** --------------------------------------------------- upstream, without content */

  /** `owner/repo`, or null when the source is not one. */
  function splitSource(source) {
    const m = /^([^/\s]+)\/([^/\s]+)$/.exec(String(source));
    return m === null ? null : { owner: m[1], repo: m[2] };
  }

  /** A token if the environment carries one, which lifts the rate limit. */
  function githubToken() {
    const t = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    return typeof t === 'string' && t.trim() !== '' ? t.trim() : '';
  }

  let ghTokenTried = false;
  let ghTokenValue = '';

  /**
   * A token from the GitHub CLI, once, and only after the budget ran out.
   *
   * Unauthenticated GitHub allows 60 requests an hour, which a check of a
   * handful of repositories exhausts in a few rounds. `gh` is commonly installed
   * and already authenticated on the machines that run into this; asking it
   * costs one process and is remembered for the life of the process.
   */
  async function ghToken() {
    if (ghTokenTried) return ghTokenValue;
    ghTokenTried = true;
    try {
      // Resolve the executable the same way `tar` is resolved: on Windows a bare
      // `gh` does not spawn, because the launcher is `gh.exe` on PATH.
      const sp = ctx.get('subprocess');
      const names = platform === 'win32' ? ['gh.exe', 'gh'] : ['gh'];
      let exe = names[0];
      if (sp !== undefined) {
        for (const n of names) {
          try {
            const p = await sp.resolveExecutable(n);
            if (p) { exe = p; break; }
          } catch (e) {
            /* try the next candidate */
          }
        }
      }
      const r = await runner([exe, 'auth', 'token'], undefined);
      if (r.code === 0 && typeof r.out === 'string' && r.out.trim() !== '') {
        ghTokenValue = r.out.trim();
      }
    } catch (e) {
      /* no gh, or not logged in: stay unauthenticated */
    }
    return ghTokenValue;
  }

  /**
   * One GitHub REST read.
   *
   * Never throws: every failure is a value, because a check that cannot reach
   * upstream has to say so per skill rather than tear the whole panel down.
   *
   * @returns `{ ok, body, remaining }` or `{ ok: false, error, rateLimited }`.
   */
  async function apiJson(urlPath) {
    const r = await apiOnce(urlPath, githubToken());
    if (r.ok || r.rateLimited !== true || githubToken() !== '') return r;
    // The budget ran out. A `gh` login raises it from 60 requests an hour to
    // 5000, and only here is it worth spending a process to find out.
    const gh = await ghToken();
    if (gh === '') return r;
    return apiOnce(urlPath, gh);
  }

  /** One attempt, with whatever token the caller settled on. */
  async function apiOnce(urlPath, token) {
    const headers = { accept: 'application/vnd.github+json' };
    if (token !== '') headers.authorization = 'Bearer ' + token;

    let timer = null;
    let init = { headers };
    if (typeof AbortController === 'function') {
      const ctl = new AbortController();
      init = { headers, signal: ctl.signal };
      timer = setTimeout(() => ctl.abort(), API_TIMEOUT_MS);
    }

    let res;
    try {
      res = await fetcher(API_BASE + urlPath, init);
    } catch (e) {
      if (timer !== null) clearTimeout(timer);
      return { ok: false, error: 'could not reach api.github.com: ' + errMsg(e) };
    }
    if (timer !== null) clearTimeout(timer);

    const remaining = res.headers && typeof res.headers.get === 'function'
      ? res.headers.get('x-ratelimit-remaining')
      : null;

    if (!res.ok) {
      const rateLimited = res.status === 403 || res.status === 429;
      return {
        ok: false,
        error: rateLimited
          ? 'api.github.com rate limit reached (set GITHUB_TOKEN, or log in with gh, to raise it)'
          : 'api.github.com returned HTTP ' + String(res.status),
        rateLimited,
      };
    }

    let body;
    try {
      body = await res.json();
    } catch (e) {
      return { ok: false, error: 'api.github.com sent unreadable JSON' };
    }
    return { ok: true, body, remaining };
  }

  /**
   * The commit id that last touched `path` in `repo`.
   *
   * An empty path means the repository's default branch tip, which answers "did
   * anything at all move?" in one request — the answer that lets a whole
   * repository be skipped without looking at its skills one by one.
   */
  async function commitShaAt(repo, path) {
    const q = path === ''
      ? '?per_page=1'
      : '?path=' + encodeURIComponent(path) + '&per_page=1';
    const r = await apiJson('/repos/' + repo + '/commits' + q);
    if (!r.ok) return r;
    if (!Array.isArray(r.body) || r.body.length === 0) {
      // The path was renamed or removed upstream. That is not "no change".
      return { ok: false, error: 'no commit found for ' + (path === '' ? 'the branch' : path) };
    }
    const sha = String(r.body[0] && r.body[0].sha ? r.body[0].sha : '');
    if (sha === '') return { ok: false, error: 'api.github.com sent no commit id' };
    return { ok: true, sha, remaining: r.remaining };
  }

  /**
   * The in-repository directory holding a skill, or `''` for a repository-root
   * skill. The recorded path is relative to the archive's tree root, so it is
   * already the repository path.
   */
  function skillDirOf(entry) {
    const p = String(entry.skillPath === undefined ? '' : entry.skillPath).replace(/\\/g, '/');
    if (p === '' || p === 'SKILL.md') return '';
    const cut = p.lastIndexOf('/');
    return cut <= 0 ? '' : p.slice(0, cut);
  }

  /**
   * Whether the installed copy was edited since it was installed.
   *
   * Purely local, so it costs no request. `null` means the recorded digest was
   * written to rules this build cannot read, and nothing is claimed either way.
   */
  async function localEditFlag(entry, dir) {
    const base = localBaselineOf(entry);
    if (base === null) return null;
    const local = await dirDigest(dir);
    return local.hash !== base;
  }

  /** The skills root a listed skill belongs to, used to locate its manifest. */
  function rootOfSkill(s) {
    if (s.dir === null) return null;
    const d = String(s.dir);
    if (basename(d) === String(s.name)) {
      const parent = dirname(d);
      if (basename(parent) === 'skills') return parent;
    }
    return dirname(d);
  }

  /** Resolve the destination root for an install or import. */
  async function targetRoot(args) {
    const a = args || {};
    const kind = a.target === 'project' ? 'project' : 'global';
    if (kind === 'project') {
      const pp = a.projectPath ? String(a.projectPath) : '';
      if (!pp) return { error: 'Select a project before installing locally.' };
      return { root: join(await projectRoot(pp), '.dsh', 'skills'), kind: 'project' };
    }
    const g = await globalRoot();
    if (g === undefined) return { error: 'Could not determine the global skills directory.' };
    return { root: g, kind: 'global' };
  }

  const exists = async (p) => {
    try {
      await lstat(p);
      return true;
    } catch (e) {
      return false;
    }
  };

  /** The client-facing view of every skill visible in one scope. */
  async function buildSkills(agent, projectPath) {
    const opts = { scope: agent };
    if (projectPath) opts.cwd = projectPath;
    let list;
    let globalOnly = null;
    if (projectPath) {
      const pair = await Promise.all([
        ctx.skills.list(opts),
        ctx.skills.list({ scope: agent }).then(
          (v) => v,
          () => null,
        ),
      ]);
      list = pair[0];
      globalOnly = pair[1];
    } else {
      list = await ctx.skills.list(opts);
    }
    const globalSources = {};
    if (globalOnly !== null) {
      for (const s of globalOnly) globalSources[String(s.name)] = String(s.source);
    }
    const skills = list.map((s) => {
      const b = s.resourceBase;
      const nm = String(s.name);
      const gsrc = globalSources[nm];
      return {
        name: nm,
        description: String(s.description === undefined ? '' : s.description),
        whenToUse: s.whenToUse === undefined ? null : String(s.whenToUse),
        source: String(s.source),
        provider: String(s.provider),
        modelInvocable: !!(s.invocation && s.invocation.modelInvocable),
        userInvocable: !!(s.invocation && s.invocation.userInvocable),
        dir: b && b.kind === 'directory' && b.path ? String(b.path) : null,
        togglable: false,
        ownerNote: null,
        mode: null,
        shadowsGlobal: projectPath && gsrc !== undefined && gsrc !== String(s.source) ? gsrc : null,
      };
    });

    // A skill is only editable here when it is a real directory that DSH owns;
    // a link belongs to another tool and must not be rewritten.
    const flags = await Promise.all(
      skills.map(async (s) => {
        if (s.dir === null) return 'no-directory';
        try {
          const li = await lstat(s.dir);
          if (li.isSymbolicLink()) return 'link';
        } catch (e) {
          return 'lstat-failed';
        }
        if (s.source !== 'user-dsh' && s.source !== 'project-dsh') return 'not-owned';
        return null;
      }),
    );
    for (let i = 0; i < skills.length; i += 1) {
      if (flags[i] === null) skills[i].togglable = true;
      else skills[i].ownerNote = flags[i];
    }

    const manifests = {};
    for (const s of skills) {
      const root = rootOfSkill(s);
      if (root === null) continue;
      if (manifests[root] === undefined) manifests[root] = await readManifest(root);
      const e = manifests[root].skills[s.name];
      if (e !== undefined && typeof e === 'object') {
        s.mode = e.mode === undefined ? 'install' : String(e.mode);
      }
    }
    return skills;
  }

  /** Map `repository/skillId` to its install mode, so search results can be badged. */
  async function installedMap(projectPath) {
    const out = {};
    const roots = [];
    const g = await globalRoot();
    if (g !== undefined) roots.push(g);
    if (projectPath) roots.push(join(await projectRoot(projectPath), '.dsh', 'skills'));
    for (const root of roots) {
      const mf = await readManifest(root);
      for (const nm in mf.skills) {
        const e = mf.skills[nm];
        if (e === null || typeof e !== 'object') continue;
        const src = String(e.source === undefined ? '' : e.source);
        const sid = String(e.skillId === undefined ? nm : e.skillId);
        // Imported skills record a local path, which must not collide with a
        // repository key.
        if (src === '' || src.indexOf('/') < 0) continue;
        out[src + '/' + sid] = e.mode === undefined ? 'install' : String(e.mode);
      }
    }
    return out;
  }

  /** Install (or re-install) one skill from its repository archive. */
  async function doInstall(a, force) {
    const source = String(a.source);
    const skillId = String(a.skillId);
    // An update has to land back where the skill already lives, not wherever the
    // panel's scope selector happens to point. Without this, updating a
    // project-scoped skill silently installed a second copy into the global root
    // instead of replacing the one the user was looking at.
    const tr = a.rootOverride === undefined
      ? await targetRoot(a)
      : { root: String(a.rootOverride), kind: a.targetKind };
    if (tr.error) return { ok: false, error: tr.error };

    const doc = await fetchDoc(source, skillId);
    if (!doc.ok) return { ok: false, error: doc.error };

    // The directory name follows the skill's own frontmatter name, not the
    // search-result id, so a renamed upstream skill lands in one stable place.
    const name = doc.name === '' ? skillId : doc.name;
    const destDir = join(tr.root, name);

    // Replacing an existing folder takes more than asking for it: the panel's
    // own record has to say that this very repository put a skill of this name
    // there. That is the Reinstall a search result offers for a skill it
    // already installed, and it is deliberately not the same thing as a folder
    // that merely shares the name — a hand-written skill is not ours to
    // overwrite, so that case still refuses below.
    const prior = (await readManifest(tr.root)).skills[name];
    const replace =
      force === true
      || (prior !== undefined
        && typeof prior === 'object'
        && String(prior.mode === undefined ? 'install' : prior.mode) === 'install'
        && String(prior.source) === source
        && String(prior.skillId) === skillId);

    if (!replace && (await exists(destDir))) {
      return {
        ok: false,
        error: 'Something already exists at ' + destDir
          + ', and it was not installed from ' + source + '.',
      };
    }

    // Replacing the folder would drop the panel's own model-invocation switch,
    // because upstream mostly does not ship the flag. Carry the setting across
    // by hand, so an update refreshes the skill without resetting a preference.
    let priorDisabled = null;
    if (replace && (await exists(destDir))) {
      try {
        priorDisabled = disableFlagOf(await readFile(join(destDir, 'SKILL.md'), 'utf8')) === true;
      } catch (e) {
        priorDisabled = null;
      }
    }

    try {
      await mkdir(tr.root, { recursive: true });
      if (replace) await rm(destDir, { recursive: true, force: true });
      // fs.cp copies bytes, so a skill's scripts and assets survive intact.
      await cp(doc.dir, destDir, { recursive: true });
      if (!(await exists(join(destDir, 'SKILL.md')))) {
        await rm(destDir, { recursive: true, force: true });
        return { ok: false, error: 'the copy produced no SKILL.md' };
      }
    } catch (e) {
      return { ok: false, error: 'could not copy the skill into place: ' + errMsg(e) };
    }

    if (priorDisabled !== null) {
      try {
        const now = await readFile(join(destDir, 'SKILL.md'), 'utf8');
        const next = withDisableFlag(now, priorDisabled);
        if (next !== null && next !== now) await writeFile(join(destDir, 'SKILL.md'), next, 'utf8');
      } catch (e) {
        /* a usable copy without the flag still beats failing the install */
      }
    }

    // Baseline the digest of what was actually copied, so a later check can ask
    // two separate questions: has upstream moved, and has this copy been edited.
    // The second baseline is read from the archive rather than from the copy, so
    // the first question is answered against upstream and nothing else.
    const dig = await dirDigest(destDir);
    const entries = dig.files;
    const upDig = await dirDigest(String(doc.dir));

    const mf = await readManifest(tr.root);
    const skillPath = doc.rel === '' ? 'SKILL.md' : doc.rel + '/SKILL.md';
    mf.skills[name] = {
      source,
      skillId,
      branch: doc.branch,
      skillPath,
      hash: dig.hash,
      hashVersion: DIGEST_VERSION,
      fileCount: entries.length,
      upstreamHash: upDig.hash,
      upstreamVersion: UPSTREAM_VERSION,
      upstreamAt: String(Date.now()),
      mode: 'install',
      at: String(Date.now()),
    };

    // Seed the commit ids the cheap check compares against, so the next check
    // can settle this skill without a second request. Best effort: if the API
    // cannot be reached the fields are simply absent, and the first check that
    // does reach it re-baselines instead of reporting a release that never was.
    const parts = splitSource(source);
    if (parts !== null) {
      try {
        const head = await commitShaAt(parts.owner + '/' + parts.repo, '');
        if (head.ok) {
          const dir = skillPath === 'SKILL.md' ? '' : skillPath.slice(0, skillPath.lastIndexOf('/'));
          let sha = head.sha;
          if (dir !== '') {
            const c = await commitShaAt(parts.owner + '/' + parts.repo, dir);
            if (c.ok) sha = c.sha;
          }
          mf.skills[name].repoHead = head.sha;
          mf.skills[name].skillSha = sha;
          mf.skills[name].upstreamCheckedAt = String(Date.now());
        }
      } catch (e) {
        /* the archive is already in place; the ids are an optimisation */
      }
    }

    await writeManifest(tr.root, mf);

    // The content changed, so any cached verdict for this root is stale. The
    // background check would otherwise keep showing the previous answer.
    try {
      const after = await readManifest(tr.root);
      after.lastCheckAt = '0';
      await writeManifest(tr.root, after);
    } catch (e) {
      /* a stale cache entry only costs one extra request */
    }

    return {
      ok: true,
      name,
      dir: destDir,
      root: tr.root,
      targetKind: tr.kind,
      via: 'archive',
      written: entries.length > 0 ? entries : ['SKILL.md'],
      failed: [],
      skipped: [],
    };
  }

  /** ------------------------------------------------------------------ methods */

  return {
    /** Panel scopes and environment capabilities. */
    async bootstrap() {
      const out = {
        ok: true,
        projects: [],
        globalRoot: null,
        webAvailable: ctx.get('web') !== undefined,
        subprocessAvailable: ctx.get('subprocess') !== undefined,
        platform,
      };
      try {
        const g = await globalRoot();
        out.globalRoot = g === undefined ? null : g;
      } catch (e) {
        /* reported as null */
      }
      const wr = ctx.get('workspaceRegistry');
      if (wr !== undefined) {
        try {
          out.projects = wr.list().map((w) => ({
            id: String(w.id),
            title: String(w.title === undefined ? '' : w.title),
            path: String(w.path),
          }));
        } catch (e) {
          out.projectsError = errMsg(e);
        }
      }
      return out;
    },

    /** Installed skills plus the repository keys already present. */
    async list(args) {
      const a = args || {};
      const agent = resolveAgent(a.sessionId);
      if (agent === undefined) {
        return { ok: false, error: 'No live session is available to resolve the skill scope.' };
      }
      try {
        const projectPath = a.projectPath ? String(a.projectPath) : '';
        const pair = await Promise.all([buildSkills(agent, projectPath), installedMap(projectPath)]);
        let scopeCwd = null;
        try {
          scopeCwd = String(agent.session.header.cwd);
        } catch (e) {
          /* informational only */
        }
        const g2 = (await globalRoot()) || null;
        return { ok: true, skills: pair[0], installed: pair[1], scopeCwd, globalRoot: g2 };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    /** The full SKILL.md of one installed skill, for the read-only viewer. */
    async body(args) {
      const a = args || {};
      const agent = resolveAgent(a.sessionId);
      if (agent === undefined) return { ok: false, error: 'No live session is available.' };
      const opts = { scope: agent };
      if (a.projectPath) opts.cwd = String(a.projectPath);
      try {
        const def = await ctx.skills.get(String(a.name), opts);
        if (def === undefined) return { ok: false, error: 'Skill not found.' };
        return {
          ok: true,
          name: String(def.name),
          content: String(def.content),
          path: def.path ? String(def.path) : null,
        };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    /** Toggle whether a skill is auto-injected into the model context. */
    async 'set-enabled'(args) {
      const a = args || {};
      const agent = resolveAgent(a.sessionId);
      if (agent === undefined) return { ok: false, error: 'No live session is available.' };
      const opts = { scope: agent };
      if (a.projectPath) opts.cwd = String(a.projectPath);
      try {
        const def = await ctx.skills.get(String(a.name), opts);
        if (def === undefined) return { ok: false, error: 'Skill not found.' };
        const p = def.path === undefined ? '' : String(def.path);
        if (p === '') return { ok: false, error: 'This skill has no file to edit.' };
        try {
          const li = await lstat(dirname(p));
          if (li.isSymbolicLink()) {
            return {
              ok: false,
              error: 'This skill is a link, so its file is shared with another tool and will not be edited here.',
            };
          }
        } catch (e) {
          /* proceed: lstat failure alone is not a reason to refuse */
        }
        const updated = withDisableFlag(await readFile(p, 'utf8'), a.enabled !== true);
        if (updated === null) {
          return { ok: false, error: 'This skill has no YAML frontmatter to update.' };
        }
        await writeFile(p, updated, 'utf8');
        return { ok: true, name: String(def.name), path: p, modelInvocable: a.enabled === true };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    /**
     * Delete a skill.
     *
     * A link is unlinked rather than removed recursively, so the folder it
     * points at — which belongs to whoever created it — is left untouched. That
     * holds for a Windows junction and a POSIX symlink alike.
     */
    async uninstall(args) {
      const a = args || {};
      const agent = resolveAgent(a.sessionId);
      if (agent === undefined) return { ok: false, error: 'No live session is available.' };
      const projectPath = a.projectPath ? String(a.projectPath) : '';
      const opts = { scope: agent };
      if (projectPath) opts.cwd = projectPath;
      try {
        const def = await ctx.skills.get(String(a.name), opts);
        if (def === undefined) return { ok: false, error: 'Skill not found.' };
        const src = String(def.source);
        const p = def.path === undefined ? '' : String(def.path);
        if (p === '') return { ok: false, error: 'This skill has no directory to remove.' };
        const dir = dirname(p);

        // Refuse anything outside a root this panel is allowed to own.
        const roots = [];
        const g = await globalRoot();
        if (g !== undefined) roots.push(g);
        if (projectPath) {
          const pr = await projectRoot(projectPath);
          roots.push(join(pr, '.dsh', 'skills'));
          roots.push(join(pr, '.agents', 'skills'));
        }
        const inside = roots.some((r) => {
          const a2 = r.replace(/[\\/]+$/, '').toLowerCase();
          const b2 = dir.replace(/[\\/]+$/, '').toLowerCase();
          // Derive the separator from `platform` rather than `path.sep` so the
          // two platform decisions in this file stay consistent and testable.
          return b2 !== a2 && b2.startsWith(a2 + (platform === 'win32' ? '\\' : '/'));
        });
        if (!inside) {
          return { ok: false, error: 'Refusing to remove: not inside a known skills root.' };
        }
        if (src !== 'user-dsh' && src !== 'project-dsh') {
          return { ok: false, error: 'Only skills under a DSH skills root can be removed.' };
        }

        let li;
        try {
          li = await lstat(dir);
        } catch (e) {
          return { ok: false, error: 'The skill directory no longer exists.' };
        }
        const isLink = li.isSymbolicLink();

        let detail = '';
        try {
          if (isLink) await unlink(dir);
          else await rm(dir, { recursive: true, force: true });
        } catch (e) {
          detail = errMsg(e);
        }

        const removed = !(await exists(dir));
        if (removed) {
          try {
            const rootDir = basename(dir) === String(def.name) ? dirname(dir) : dir;
            const mf = await readManifest(rootDir);
            if (mf.skills[String(def.name)] !== undefined) {
              delete mf.skills[String(def.name)];
              await writeManifest(rootDir, mf);
            }
          } catch (e) {
            /* a stale manifest entry is harmless */
          }
        }
        return {
          ok: removed,
          name: String(def.name),
          dir,
          linked: isLink,
          removed,
          detail: removed ? '' : detail,
        };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    /**
     * Compare every panel-installed skill against upstream.
     *
     * Asks by commit id rather than by content: one request per repository says
     * whether anything in it moved at all, and a skill directory's last commit
     * says whether that skill moved. Nothing is downloaded, so a check costs
     * kilobytes instead of every repository's archive — on the slow link this
     * was reported from, 26.8 MB and four and a half minutes became about 40 KB
     * and a couple of seconds.
     *
     * A repository whose tip is unchanged settles every skill inside it without
     * a second request. A result stands for `MIN_CHECK_MS`, so reloading the page
     * asks nothing; pass `force` to bypass that.
     *
     * If api.github.com cannot answer for a repository, that repository falls
     * back to comparing archives, which is slow but still correct. Content is
     * read only for installs and updates.
     */
    async 'check-updates'(args) {
      const a = args || {};
      const agent = resolveAgent(a.sessionId);
      if (agent === undefined) return { ok: false, error: 'No live session is available.' };
      try {
        const skills = await buildSkills(agent, a.projectPath ? String(a.projectPath) : '');

        // Skills the panel installed, grouped by the root whose manifest records
        // them — one manifest read per root rather than one per skill.
        const byRoot = new Map();
        const updates = {};
        for (const s of skills) {
          if (s.mode !== 'install') continue;
          const root = rootOfSkill(s);
          if (root === null || s.dir === null) {
            updates[s.name] = { status: 'no-record' };
            continue;
          }
          if (!byRoot.has(root)) byRoot.set(root, []);
          byRoot.get(root).push(s);
        }

        let checkedAt = 0;
        let cached = false;
        let rateLimited = false;
        let fellBack = false;

        for (const [root, list] of byRoot) {
          const mf = await readManifest(root);
          const last = Number(mf.lastCheckAt === undefined ? 0 : mf.lastCheckAt);

          // Reuse is opt-in, and only the background check asks for it: a call
          // that says nothing means "check now" and always asks upstream. The
          // recent result is also what the panel shows as "last checked", so it
          // is recorded either way.
          if (a.reuse === true && a.force !== true
            && Date.now() - last < MIN_CHECK_MS
            && mf.lastCheckResults !== undefined && mf.lastCheckResults !== null) {
            for (const nm in mf.lastCheckResults) updates[nm] = mf.lastCheckResults[nm];
            cached = true;
            checkedAt = Math.max(checkedAt, last);
            continue;
          }

          const r = await checkRoot(root, mf, list);
          Object.assign(updates, r.updates);
          if (r.rateLimited) rateLimited = true;
          if (r.fellBack) fellBack = true;
          checkedAt = Math.max(checkedAt, r.checkedAt);
        }

        return {
          ok: true,
          updates,
          checkedAt: checkedAt === 0 ? null : checkedAt,
          cached,
          rateLimited,
          fellBack,
          nextCheckInMs: MIN_CHECK_MS,
        };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    /** Re-install one skill, but only after confirming it actually changed. */
    async update(args) {
      const a = args || {};
      const agent = resolveAgent(a.sessionId);
      if (agent === undefined) return { ok: false, error: 'No live session is available.' };
      try {
        const name = String(a.name);
        const skills = await buildSkills(agent, a.projectPath ? String(a.projectPath) : '');
        let found = null;
        for (const s of skills) {
          if (s.name === name) {
            found = s;
            break;
          }
        }
        if (found === null) return { ok: false, error: 'Skill not found.' };
        const root = rootOfSkill(found);
        if (root === null || found.dir === null) {
          return { ok: false, error: 'This skill has no directory.' };
        }
        const mf = await readManifest(root);
        const e = mf.skills[name];
        if (e === undefined) {
          return { ok: false, error: 'No recorded source for this skill, so it cannot be updated.' };
        }
        if (String(e.mode) !== 'install') {
          return { ok: false, error: 'This skill was imported, and imported skills are not updated.' };
        }

        // No memo to drop first: `fetchDoc` answers for the tree generation it
        // read from, so a re-downloaded archive is always read freshly.
        const chk = await fetchDoc(String(e.source), String(e.skillId));
        if (!chk.ok) return { ok: false, error: chk.error };

        // Upstream may not have moved at all. Then there is nothing to apply and
        // the installed copy is left strictly alone, local edits included. The
        // verdict is upstream's: a switch flip or an edit cannot reach it.
        const up = await dirDigest(String(chk.dir));
        if (up.files.length === 0) {
          // The tree vanished under us; saying "no change" would be a guess, and
          // installing from a tree we cannot read is not possible.
          return { ok: false, error: 'The repository archive could not be read this time. Try again.' };
        }
        const verdict = await compareWithUpstream(root, name, e, String(found.dir), up.hash);
        if (verdict.status === 'current') {
          return {
            ok: true,
            upToDate: true,
            name,
            written: [],
            failed: [],
            via: null,
            rebased: verdict.rebased === true,
          };
        }

        // An update replaces the folder outright, so a copy that no longer
        // matches the baseline would lose whatever was changed in it. Say so and
        // let the caller decide; `force` is that decision.
        const locallyModified = verdict.locallyModified;
        if (locallyModified && a.force !== true) {
          return {
            ok: false,
            locallyModified: true,
            error: 'This skill has local changes, and updating replaces the whole folder.',
          };
        }

        const g = await globalRoot();
        const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
        const r = await doInstall(
          {
            source: String(e.source),
            skillId: String(e.skillId),
            rootOverride: root,
            targetKind: g !== undefined && norm(root) === norm(g) ? 'global' : 'project',
          },
          true,
        );
        if (!r.ok) return r;
        return {
          ok: true,
          upToDate: false,
          name: r.name,
          dir: r.dir,
          written: r.written,
          failed: r.failed,
          via: r.via,
          replacedLocalChanges: locallyModified,
        };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    /**
     * Attach a repository to a skill this panel did not install.
     *
     * Only the panel's own installs carry provenance, so a skill brought in from
     * a repository by other means is skipped by every check. Nothing on disk can
     * stand in for it either: a folder unpacked from a tarball has no `.git`, so
     * there is no remote to read. The source has to be stated once. After that
     * the skill is indistinguishable from a panel install.
     *
     * Two phases on purpose. Without `confirm` this only reports what the
     * repository holds, because attaching is what lets a later update REPLACE
     * the local folder — a guessed source would let someone else's copy
     * overwrite the user's own work.
     */
    async adopt(args) {
      const a = args || {};
      const agent = resolveAgent(a.sessionId);
      if (agent === undefined) return { ok: false, error: 'No live session is available.' };
      try {
        const name = String(a.name || '');
        if (name === '') return { ok: false, error: 'No skill was named.' };
        // Accept what a person is likely to paste: a full URL, a clone URL, or
        // the bare owner/repo the search results already use.
        const source = String(a.source || '')
          .trim()
          .replace(/^https?:\/\/github\.com\//i, '')
          .replace(/\.git$/i, '')
          .replace(/\/+$/, '');
        if (!/^[^/\s]+\/[^/\s]+$/.test(source)) {
          return { ok: false, error: 'Give the source as owner/repo.' };
        }

        const skills = await buildSkills(agent, a.projectPath ? String(a.projectPath) : '');
        let found = null;
        for (const s of skills) {
          if (s.name === name) {
            found = s;
            break;
          }
        }
        if (found === null) return { ok: false, error: 'Skill not found.' };
        if (found.dir === null) return { ok: false, error: 'This skill has no directory.' };
        const root = rootOfSkill(found);
        if (root === null) return { ok: false, error: 'This skill has no skills root.' };

        const skillId = String(a.skillId || name);
        const doc = await fetchDoc(source, skillId);
        if (!doc.ok) return { ok: false, error: doc.error };

        const upstream = await dirDigest(String(doc.dir));
        const local = await dirDigest(String(found.dir));
        const skillPath = doc.rel === '' ? 'SKILL.md' : doc.rel + '/SKILL.md';
        const existing = (await readManifest(root)).skills[name];

        if (a.confirm !== true) {
          return {
            ok: true,
            needsConfirm: true,
            name,
            found: { name: doc.name, skillPath, fileCount: upstream.files.length },
            localFileCount: local.files.length,
            matchesUpstream: upstream.hash === local.hash,
            replaces: existing === undefined ? null : String(existing.source),
          };
        }

        const mf = await readManifest(root);
        mf.skills[name] = {
          source,
          skillId,
          branch: doc.branch,
          skillPath,
          // The copy's own digest is baselined from what is on disk: this copy
          // may be a fork, and the local baseline's job is to notice your edits,
          // not to flag your own work as an edit the instant you attach it.
          hash: local.hash,
          hashVersion: DIGEST_VERSION,
          fileCount: local.files.length,
          // The upstream baseline is what the repository holds right now, which
          // is what a later "has upstream moved" has to be measured against.
          // Attaching still reports no pending update: with both baselines on
          // today's content, the next change reported is upstream's own.
          upstreamHash: upstream.hash,
          upstreamVersion: UPSTREAM_VERSION,
          upstreamAt: String(Date.now()),
          mode: 'install',
          adopted: true,
          at: String(Date.now()),
        };
        await writeManifest(root, mf);
        return {
          ok: true,
          adopted: true,
          name,
          source,
          skillId,
          skillPath,
          matchesUpstream: upstream.hash === local.hash,
        };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    /**
     * Import a skill folder from disk, by link or by copy.
     *
     * `fs.symlink(..., 'junction')` creates a Windows junction without needing
     * elevation; on POSIX the type argument is ignored and a normal symlink is
     * made. Either way the original folder stays the source of truth.
     */
    async 'import-skill'(args) {
      const a = args || {};
      const raw = String(a.sourcePath || '').trim();
      if (raw === '') return { ok: false, error: 'Give the folder that holds the skill (or its SKILL.md).' };
      const mode = a.mode === 'copy' ? 'copy' : 'link';
      try {
        let skillDir = raw;
        let info = null;
        try {
          info = await lstat(raw);
        } catch (e) {
          info = null;
        }
        if (info === null) return { ok: false, error: 'Path not found: ' + raw };
        if (info.isFile()) {
          if (basename(raw).toLowerCase() !== 'skill.md') {
            return { ok: false, error: 'That file is not a SKILL.md.' };
          }
          skillDir = dirname(raw);
        } else if (!info.isDirectory()) {
          return { ok: false, error: 'Path is neither a folder nor SKILL.md.' };
        }

        let mdText = '';
        try {
          mdText = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
        } catch (e) {
          return { ok: false, error: 'No readable SKILL.md inside ' + skillDir };
        }
        const name = parseSkillName(mdText, basename(skillDir));
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
          return { ok: false, error: 'Could not derive a valid skill name.' };
        }

        const tr = await targetRoot(a);
        if (tr.error) return { ok: false, error: tr.error };
        const destDir = join(tr.root, name);
        if (await exists(destDir)) {
          return { ok: false, error: 'Something already exists at ' + destDir };
        }

        await mkdir(tr.root, { recursive: true });
        let written = [];
        if (mode === 'link') {
          try {
            await symlink(skillDir, destDir, platform === 'win32' ? 'junction' : 'dir');
          } catch (e) {
            return { ok: false, error: 'Link creation failed: ' + errMsg(e) };
          }
          written = ['(link)'];
        } else {
          try {
            await cp(skillDir, destDir, { recursive: true });
          } catch (e) {
            return { ok: false, error: 'Copy failed: ' + errMsg(e) };
          }
          try {
            written = await readdir(destDir);
          } catch (e) {
            written = ['SKILL.md'];
          }
        }

        const mf = await readManifest(tr.root);
        mf.skills[name] = {
          source: skillDir,
          skillId: name,
          branch: '',
          skillPath: 'SKILL.md',
          hash: hashText(mdText.trim()),
          mode,
          at: String(Date.now()),
        };
        await writeManifest(tr.root, mf);

        return {
          ok: true,
          name,
          dir: destDir,
          root: tr.root,
          targetKind: tr.kind,
          mode,
          written,
          skipped: [],
        };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    /** Search skills.sh. */
    async search(args) {
      const w = ctx.get('web');
      if (w === undefined) {
        return { ok: false, error: 'No web provider is configured, so skills.sh search is unavailable.' };
      }
      const q = String((args && args.query) || '').trim();
      if (q.length < 2) return { ok: false, error: 'Enter at least two characters.' };
      try {
        const r = await w.fetch({
          url: 'https://www.skills.sh/api/search?q=' + encodeURIComponent(q) + '&limit=30',
        });
        if (r.statusCode !== 200) {
          return { ok: false, error: 'skills.sh returned HTTP ' + r.statusCode + '.' };
        }
        if (r.truncated) return { ok: false, error: 'The skills.sh response was truncated.' };
        const data = JSON.parse(String(r.body.content));
        const results = (Array.isArray(data.skills) ? data.skills : []).map((s) => ({
          name: String(s.name),
          source: String(s.source),
          installs: Number(s.installs || 0),
          skillId: String(s.skillId || s.name),
        }));
        return { ok: true, results };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    /** Install one skill from a repository archive. */
    async install(args) {
      const a = args || {};
      if (options.run === undefined && ctx.get('subprocess') === undefined) {
        return { ok: false, error: 'No subprocess capability is available, so archives cannot be extracted.' };
      }
      try {
        return await doInstall(a, false);
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },
  };
}
