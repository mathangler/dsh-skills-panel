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
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

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
   * @returns `{ root, branch }` or `{ error }`.
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
        if (rootStat.isDirectory()) return { root: meta.root, branch: meta.branch };
      }
    } catch (e) {
      /* cache miss: rebuild below */
    }

    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const tgz = join(dir, 'repo.tgz');
    const xdir = join(dir, 'x');
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

      const r = await runner([await resolveTar(), '-xzf', tgz, '-C', xdir], dir);
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

      const root = join(xdir, tops[0].name);
      await writeFile(metaPath, JSON.stringify({ branch: ref, root, at: Date.now() }));
      return { root, branch: ref };
    }

    return { error: lastError || 'could not download the repository archive' };
  }

  /** Read a skill's SKILL.md straight out of the repository archive. */
  async function fetchDoc(source, skillId) {
    const key = source + '/' + skillId;
    if (docCache[key] !== undefined) return docCache[key];

    const tree = await ensureTree(source);
    if (tree.error !== undefined) return { error: tree.error };

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
    docCache[key] = out;
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

  /**
   * The global skills root, derived from the settings document rather than from
   * `~`, because the value must be an absolute path on every platform.
   */
  async function computeGlobalRoot() {
    const st = ctx.get('settings');
    if (st !== undefined) {
      try {
        const doc = await st.prepareDocument();
        if (typeof doc === 'string' && doc.length > 0) return join(dirname(doc), 'skills');
      } catch (e) {
        /* fall back to resource-base discovery below */
      }
    }
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
        /* unrecoverable: caller reports the missing root */
      }
    }
    return undefined;
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
      return { root: join(pp, '.dsh', 'skills'), kind: 'project' };
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
    if (projectPath) roots.push(join(projectPath, '.dsh', 'skills'));
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
    const tr = await targetRoot(a);
    if (tr.error) return { ok: false, error: tr.error };

    const doc = await fetchDoc(source, skillId);
    if (!doc.ok) return { ok: false, error: doc.error };

    // The directory name follows the skill's own frontmatter name, not the
    // search-result id, so a renamed upstream skill lands in one stable place.
    const name = doc.name === '' ? skillId : doc.name;
    const destDir = join(tr.root, name);

    if (force !== true && (await exists(destDir))) {
      return { ok: false, error: 'Something already exists at ' + destDir };
    }

    try {
      await mkdir(tr.root, { recursive: true });
      if (force === true) await rm(destDir, { recursive: true, force: true });
      // fs.cp copies bytes, so a skill's scripts and assets survive intact.
      await cp(doc.dir, destDir, { recursive: true });
      if (!(await exists(join(destDir, 'SKILL.md')))) {
        await rm(destDir, { recursive: true, force: true });
        return { ok: false, error: 'the copy produced no SKILL.md' };
      }
    } catch (e) {
      return { ok: false, error: 'could not copy the skill into place: ' + errMsg(e) };
    }

    let text = '';
    try {
      text = await readFile(join(destDir, 'SKILL.md'), 'utf8');
    } catch (e) {
      /* the hash is optional */
    }
    let entries = [];
    try {
      entries = (await readdir(destDir)).map(String);
    } catch (e) {
      /* the entry list is cosmetic */
    }

    const mf = await readManifest(tr.root);
    mf.skills[name] = {
      source,
      skillId,
      branch: doc.branch,
      skillPath: doc.rel === '' ? 'SKILL.md' : doc.rel + '/SKILL.md',
      hash: text === '' ? '' : hashText(text.trim()),
      mode: 'install',
      at: String(Date.now()),
    };
    await writeManifest(tr.root, mf);

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
          roots.push(join(projectPath, '.dsh', 'skills'));
          roots.push(join(projectPath, '.agents', 'skills'));
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

    /** Compare every panel-installed skill against its repository copy. */
    async 'check-updates'(args) {
      const a = args || {};
      const agent = resolveAgent(a.sessionId);
      if (agent === undefined) return { ok: false, error: 'No live session is available.' };
      try {
        const skills = await buildSkills(agent, a.projectPath ? String(a.projectPath) : '');
        const updates = {};
        for (const s of skills) {
          if (s.mode !== 'install') continue;
          try {
            const root = rootOfSkill(s);
            if (root === null) {
              updates[s.name] = { status: 'no-record' };
              continue;
            }
            const mf = await readManifest(root);
            const e = mf.skills[s.name];
            if (e === undefined) {
              updates[s.name] = { status: 'no-record' };
              continue;
            }
            const d = await fetchDoc(String(e.source), String(e.skillId));
            if (!d.ok) {
              updates[s.name] = { status: 'unreachable' };
              continue;
            }
            updates[s.name] =
              hashText(String(d.content).trim()) === String(e.hash)
                ? { status: 'current' }
                : { status: 'update' };
          } catch (err) {
            updates[s.name] = { status: 'unreachable' };
          }
        }
        return { ok: true, updates };
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
        if (root === null) return { ok: false, error: 'This skill has no directory.' };
        const mf = await readManifest(root);
        const e = mf.skills[name];
        if (e === undefined) {
          return { ok: false, error: 'No recorded source for this skill, so it cannot be updated.' };
        }
        if (String(e.mode) !== 'install') {
          return { ok: false, error: 'This skill was imported, and imported skills are not updated.' };
        }

        const key = String(e.source) + '/' + String(e.skillId);
        delete docCache[key];
        const chk = await fetchDoc(String(e.source), String(e.skillId));
        if (
          chk.ok &&
          String(e.hash) !== '' &&
          hashText(String(chk.content).trim()) === String(e.hash)
        ) {
          // Nothing to do: leave the installed copy untouched.
          return { ok: true, upToDate: true, name, written: [], failed: [], via: null };
        }

        const r = await doInstall(
          { source: String(e.source), skillId: String(e.skillId), target: a.target, projectPath: a.projectPath },
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
