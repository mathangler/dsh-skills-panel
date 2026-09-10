/**
 * Transport-free host logic for the DSH skills panel.
 *
 * Every function here talks only to Cordis services (`fs`, `subprocess`, `web`,
 * `settings`, `agents`, `skills`, `workspaceRegistry`), never to a client. The
 * package's `lib/index.js` adapts this map onto whatever host->client RPC the
 * running DSH version provides.
 *
 * @module dsh-skills-panel/host-core
 */

const BS = String.fromCharCode(92);
const CRLF = String.fromCharCode(13, 10);

const errMsg = (e) => String(e && e.message ? e.message : e);

const MANIFEST = '.skills-panel.json';
const BINARY_EXT = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'zip', 'gz', 'tgz', 'tar',
  'pdf', 'woff', 'woff2', 'ttf', 'otf', 'exe', 'dll', 'so', 'dylib', 'mp4',
  'mp3', 'wav', 'class', 'jar', 'node',
];

/**
 * PowerShell driver for every network-facing operation.
 *
 * Deliberately avoids `api.github.com` (60 requests/hour anonymously) and
 * `raw.githubusercontent.com` (unreachable on some networks): the repository is
 * fetched once as a codeload tarball, extracted into a short-lived cache, and
 * every later read — install, doc preview, update check — is served from that
 * extracted tree. Written to disk by `ensureScript` rather than passed on the
 * command line, to avoid quoting hazards.
 */
const PS_SCRIPT = [
  "param([string]$Source,[string]$Skill,[string]$Root,[string]$Tmp,[string]$Mode='install',[switch]$Force)",
  "$ErrorActionPreference = 'Stop'",
  'function Fail([string]$m){ Write-Output ("ERR: " + $m); exit 2 }',
  'New-Item -ItemType Directory -Path $Tmp -Force | Out-Null',
  "Get-ChildItem -LiteralPath $Tmp -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith('x_') -and ((Get-Date) - $_.LastWriteTime).TotalMinutes -gt 10 } | ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }",
  "$branch = ''",
  'try {',
  '  $ls = & git ls-remote --symref ("https://github.com/" + $Source) HEAD 2>$null',
  '  foreach($line in $ls){',
  "    if($line.StartsWith('ref: refs/heads/')){",
  '      $b = $line.Substring(17)',
  '      $i = $b.IndexOf([char]9)',
  "      $j = $b.IndexOf(' ')",
  '      if($j -gt 0 -and ($i -lt 0 -or $j -lt $i)){ $i = $j }',
  '      if($i -gt 0){ $b = $b.Substring(0,$i) }',
  '      $branch = $b.Trim()',
  '    }',
  '  }',
  '} catch { }',
  "if($branch -eq ''){ $branch = 'main' }",
  'function FindTree {',
  "  $dirs = @(Get-ChildItem -LiteralPath $Tmp -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name.StartsWith('x_') })",
  '  foreach($d in $dirs){',
  '    $inner = @(Get-ChildItem -LiteralPath $d.FullName -Directory -ErrorAction SilentlyContinue)',
  '    if($inner.Count -gt 0){ return @{ ex = $d.FullName; root = $inner[0].FullName; branch = $d.Name.Substring(2) } }',
  '  }',
  '  return $null',
  '}',
  '$tree = FindTree',
  'if(-not $tree){',
  "  $tgz = Join-Path $Tmp 'repo.tar.gz'",
  '  $ok = $false',
  "  foreach($b in @($branch,'main','master')){",
  '    $ex = Join-Path $Tmp ("x_" + $b)',
  '    if(Test-Path $ex){ Remove-Item $ex -Recurse -Force -ErrorAction SilentlyContinue }',
  '    & curl.exe -fsS -L --max-time 240 -o $tgz ("https://codeload.github.com/" + $Source + "/tar.gz/" + $b) 2>$null',
  '    if((Test-Path $tgz) -and ((Get-Item $tgz).Length -gt 200)){',
  '      New-Item -ItemType Directory -Path $ex -Force | Out-Null',
  '      & tar.exe -xzf $tgz -C $ex 2>$null',
  '      if($LASTEXITCODE -eq 0){ $branch = $b; $ok = $true; break }',
  '    }',
  '  }',
  "  if(-not $ok){ Fail 'download or extract failed' }",
  '  $ex = Join-Path $Tmp ("x_" + $branch)',
  "  if(-not (Test-Path $ex)){ $ex = (Get-ChildItem -LiteralPath $Tmp -Directory | Where-Object { $_.Name.StartsWith('x_') } | Select-Object -First 1).FullName }",
  '  $rootDir = (Get-ChildItem -LiteralPath $ex -Directory | Select-Object -First 1).FullName',
  "  if(-not $rootDir){ Fail 'nothing extracted' }",
  '  $tree = @{ ex = $ex; root = $rootDir; branch = $branch }',
  '}',
  '$rootDir = $tree.root',
  '$branch = $tree.branch',
  '$src = $null',
  "if($Skill -ne ''){",
  '  $hits = Get-ChildItem -LiteralPath $rootDir -Recurse -Directory -Filter $Skill -ErrorAction SilentlyContinue',
  '  $good = @()',
  "  foreach($hh in $hits){ if(Test-Path (Join-Path $hh.FullName 'SKILL.md')){ $good += $hh } }",
  '  if($good.Count -gt 0){ $src = ($good | Sort-Object { $_.FullName.Length } | Select-Object -First 1).FullName }',
  '}',
  "if(-not $src){ if(Test-Path (Join-Path $rootDir 'SKILL.md')){ $src = $rootDir } }",
  'if(-not $src){ Fail ("skill not found: " + $Skill) }',
  '$rel = $src',
  'if($rel.Length -ge $rootDir.Length){ $rel = $rel.Substring($rootDir.Length) }',
  '$rel = $rel.Trim([char]92, [char]47)',
  '$rel = $rel.Replace([char]92, [char]47)',
  "$name = ''",
  "try { foreach($line in (Get-Content (Join-Path $src 'SKILL.md') -TotalCount 30)){ if($line -like 'name:*'){ $name = $line.Substring(5).Trim().Trim([char]34).Trim([char]39); break } } } catch { }",
  "if($name -eq '' -or ($name -notmatch '^[a-z0-9]+(-[a-z0-9]+)*$')){ $name = $Skill }",
  "$meta = 'name=' + $name + ' branch=' + $branch + ' rel=' + $rel",
  "if($Mode -eq 'doc'){",
  "  Write-Output '===META==='",
  '  Write-Output $meta',
  "  Write-Output '===DOC==='",
  "  Get-Content -LiteralPath (Join-Path $src 'SKILL.md') -Raw",
  '  exit 0',
  '}',
  '$dest = Join-Path $Root $name',
  'if(Test-Path $dest){',
  '  if($Force){ Remove-Item -LiteralPath $dest -Recurse -Force } else { Fail ("destination exists: " + $dest) }',
  '}',
  'New-Item -ItemType Directory -Path $Root -Force | Out-Null',
  'Copy-Item -LiteralPath $src -Destination $dest -Recurse -Force',
  "if(-not (Test-Path (Join-Path $dest 'SKILL.md'))){ Fail 'copy produced no SKILL.md' }",
  "Write-Output ('OK ' + $meta)",
  'exit 0',
].join(CRLF);

/** Last path segment, tolerating either separator. */
function baseName(p) {
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf(BS), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Parent directory, tolerating either separator. */
function dirName(p) {
  const i = Math.max(p.lastIndexOf(BS), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

/** Join with a forward slash and no doubled separators. */
function pjoin(a, b) {
  return String(a).replace(/[\\/]+$/, '') + '/' + String(b).replace(/^[\\/]+/, '');
}

/** Case- and separator-insensitive form for containment checks. */
function normPath(p) {
  return String(p).replace(/\\/g, '/').replace(/[\\/]+$/, '').toLowerCase();
}

/** Lower-case extension without the dot. */
function extOf(p) {
  const i = String(p).lastIndexOf('.');
  return i < 0 ? '' : String(p).slice(i + 1).toLowerCase();
}

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

/** Frontmatter `description`. */
function parseDescription(c) {
  return fmValue(fmBlock(c), 'description');
}

/** SKILL.md with its frontmatter removed. */
function bodyOf(c) {
  return String(c).replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '').trim();
}

/** Parse `key=value` tokens from either script mode's metadata line. */
function keysFrom(text) {
  const out = { name: '', branch: '', rel: '' };
  for (const tok of String(text).split(/\s+/)) {
    if (tok.indexOf('name=') === 0) out.name = tok.slice(5);
    else if (tok.indexOf('branch=') === 0) out.branch = tok.slice(7);
    else if (tok.indexOf('rel=') === 0) out.rel = tok.slice(4);
  }
  return out;
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

/**
 * Build the panel's host-side method map.
 *
 * @param ctx - the Cordis context of the mounted plugin row.
 * @returns plain async functions, one per client-callable method. Every one
 *   resolves to JSON-safe data; none throws, so a failure surfaces in the UI
 *   instead of tearing down the transport.
 */
export function createHandlers(ctx) {
  const web = () => ctx.get('web');
  const fs = () => ctx.get('fs');
  const sp = () => ctx.get('subprocess');

  const descCache = {};
  const docCache = {};
  let scriptPath = null;
  let scratch = null;
  let psExe;
  let queue = Promise.resolve();

  /**
   * Serialize script invocations.
   *
   * Descriptions, previews, update checks and installs all drive the same
   * extracted-tree cache; letting two of them run at once would race on the
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
   * The global skills root, derived from the settings document rather than
   * from `~`, because `fs.resolve` does not expand a tilde.
   */
  async function computeGlobalRoot() {
    const st = ctx.get('settings');
    if (st !== undefined) {
      try {
        const doc = await st.prepareDocument();
        if (typeof doc === 'string' && doc.length > 0) return pjoin(dirName(doc), 'skills');
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
            return dirName(String(b.path));
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

  /** A stable writable directory outside the skills root, for script and caches. */
  async function scratchDir() {
    if (scratch !== null) return scratch;
    const g = await globalRoot();
    if (g === undefined) return undefined;
    scratch = dirName(g);
    return scratch;
  }

  async function readManifest(f, root) {
    const empty = { version: 1, skills: {} };
    try {
      const t = await f.resolve(pjoin(root, MANIFEST));
      if ((await f.stat(t)) === undefined) return empty;
      const data = JSON.parse(String(await f.readText(t)));
      if (data === null || typeof data !== 'object' || Array.isArray(data)) return empty;
      if (data.skills === null || typeof data.skills !== 'object' || Array.isArray(data.skills)) {
        data.skills = {};
      }
      return data;
    } catch (e) {
      return empty;
    }
  }

  async function writeManifest(f, root, data) {
    await f.writeText(await f.resolve(pjoin(root, MANIFEST)), JSON.stringify(data, null, 2));
  }

  /** The skills root a listed skill belongs to, used to locate its manifest. */
  function rootOfSkill(s) {
    if (s.dir === null) return null;
    const d = String(s.dir);
    if (d.length > s.name.length && d.slice(-s.name.length) === s.name) {
      const parent = dirName(d);
      if (baseName(parent) === 'skills') return parent;
    }
    return d;
  }

  /** Spawn a process and collect its trimmed stdout/stderr. */
  async function runCaptured(argv, cwd, graceMs) {
    const s = sp();
    if (s === undefined) return { code: null, out: '', err: 'no subprocess service' };
    try {
      const h = s.spawn({
        argv,
        cwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 524288 }, stderr: { maxBytes: 131072 } },
        graceMs,
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

  async function resolvePs() {
    if (psExe !== undefined) return psExe;
    const s = sp();
    if (s === undefined) {
      psExe = null;
      return psExe;
    }
    try {
      psExe = await s.resolveExecutable('pwsh.exe');
    } catch (e) {
      try {
        psExe = await s.resolveExecutable('powershell.exe');
      } catch (e2) {
        psExe = null;
      }
    }
    return psExe;
  }

  async function ensureScript(f, base) {
    if (scriptPath !== null) return scriptPath;
    if (sp() === undefined) return null;
    const p = pjoin(pjoin(base, '.skills-panel-tmp'), 'fetch.ps1');
    await f.writeText(await f.resolve(p), PS_SCRIPT);
    scriptPath = p;
    return p;
  }

  /** Run the driver script under the shared lock. */
  function runScript(mode, source, skillId, root, force) {
    return withLock(async () => {
      const f = fs();
      const base = await scratchDir();
      if (f === undefined || base === undefined) {
        return { code: null, out: '', err: 'no filesystem or scratch directory' };
      }
      const script = await ensureScript(f, base);
      if (script === null) return { code: null, out: '', err: 'no subprocess service' };
      const ps = await resolvePs();
      if (ps === null) return { code: null, out: '', err: 'no PowerShell available' };
      const argv = [
        ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-Source', String(source), '-Skill', String(skillId), '-Root', String(root),
        '-Tmp', pjoin(base, '.skills-panel-tmp'), '-Mode', mode,
      ];
      if (force === true) argv.push('-Force');
      return runCaptured(argv, base, 300000);
    });
  }

  /** Read a skill's SKILL.md straight out of the repository archive. */
  async function fetchDoc(source, skillId) {
    const key = source + '/' + skillId;
    if (docCache[key] !== undefined) return docCache[key];
    const base = await scratchDir();
    if (base === undefined) return { error: 'could not determine the skills root' };
    const r = await runScript('doc', source, skillId, pjoin(base, '.skills-panel-tmp'), false);
    if (r.code !== 0) {
      return { error: String(r.err || r.out || 'exit ' + String(r.code)).slice(0, 400) };
    }
    const text = String(r.out);
    const mi = text.indexOf('===META===');
    const di = text.indexOf('===DOC===');
    if (mi < 0 || di < 0) {
      return { error: 'unexpected output from the fetch script: ' + text.slice(0, 200) };
    }
    const k = keysFrom(text.slice(mi + 10, di));
    const content = text.slice(di + 9).replace(/^[\r\n]+/, '');
    const out = { ok: true, name: k.name, rel: k.rel, branch: k.branch, content };
    docCache[key] = out;
    return out;
  }

  /** Resolve the destination root for an install or import. */
  async function targetRoot(args) {
    const a = args || {};
    const kind = a.target === 'project' ? 'project' : 'global';
    if (kind === 'project') {
      const pp = a.projectPath ? String(a.projectPath) : '';
      if (!pp) return { error: 'Select a project before installing locally.' };
      return { root: pjoin(pp, '.dsh/skills'), kind: 'project' };
    }
    const g = await globalRoot();
    if (g === undefined) return { error: 'Could not determine the global skills directory.' };
    return { root: g, kind: 'global' };
  }

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

    const f = fs();
    // A skill is only editable here when it is a real directory that DSH owns;
    // a junction belongs to another tool and must not be rewritten.
    const flags = await Promise.all(
      skills.map((s) => {
        if (s.dir === null) return Promise.resolve('no-directory');
        if (f === undefined) return Promise.resolve('no-fs');
        return f.lstat(s.dir).then(
          (li) => {
            if (li !== undefined && li.type === 'symlink') return 'link';
            if (s.source !== 'user-dsh' && s.source !== 'project-dsh') return 'not-owned';
            return null;
          },
          () => 'lstat-failed',
        );
      }),
    );
    for (let i = 0; i < skills.length; i += 1) {
      if (flags[i] === null) skills[i].togglable = true;
      else skills[i].ownerNote = flags[i];
    }

    if (f !== undefined) {
      const manifests = {};
      for (const s of skills) {
        const root = rootOfSkill(s);
        if (root === null) continue;
        if (manifests[root] === undefined) manifests[root] = await readManifest(f, root);
        const e = manifests[root].skills[s.name];
        if (e !== undefined && typeof e === 'object') {
          s.mode = e.mode === undefined ? 'install' : String(e.mode);
        }
      }
    }
    return skills;
  }

  /** Map `repository/skillId` to its install mode, so search results can be badged. */
  async function installedMap(projectPath) {
    const f = fs();
    const out = {};
    if (f === undefined) return out;
    const roots = [];
    const g = await globalRoot();
    if (g !== undefined) roots.push(g);
    if (projectPath) roots.push(pjoin(projectPath, '.dsh/skills'));
    for (const root of roots) {
      const mf = await readManifest(f, root);
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

  async function doInstall(a, force) {
    const f = fs();
    if (f === undefined) return { ok: false, error: 'No filesystem service is available.' };
    const source = String(a.source);
    const skillId = String(a.skillId);
    const tr = await targetRoot(a);
    if (tr.error) return { ok: false, error: tr.error };

    const r = await runScript('install', source, skillId, tr.root, force === true);
    if (r.code !== 0) return { ok: false, error: r.err || r.out || 'exit ' + String(r.code) };
    const out = String(r.out);
    if (out.indexOf('OK ') !== 0) {
      return { ok: false, error: 'unexpected output from the install script: ' + out.slice(0, 200) };
    }
    const k = keysFrom(out.slice(3));
    if (k.name === '') return { ok: false, error: 'the install script reported no skill name' };
    const destDir = pjoin(tr.root, k.name);

    let text = '';
    try {
      text = String(await f.readText(await f.resolve(pjoin(destDir, 'SKILL.md'))));
    } catch (e) {
      /* the hash is optional */
    }
    let entries = [];
    try {
      entries = (await f.listDir(await f.resolve(destDir))).map((e) => String(e.name));
    } catch (e) {
      /* the entry list is cosmetic */
    }

    const mf = await readManifest(f, tr.root);
    mf.skills[k.name] = {
      source,
      skillId,
      branch: k.branch,
      skillPath: k.rel === '' ? 'SKILL.md' : k.rel + '/SKILL.md',
      hash: text === '' ? '' : hashText(text.trim()),
      mode: 'install',
      at: String(Date.now()),
    };
    await writeManifest(f, tr.root, mf);
    return {
      ok: true,
      name: k.name,
      dir: destDir,
      root: tr.root,
      targetKind: tr.kind,
      via: 'archive',
      written: entries.length > 0 ? entries : ['SKILL.md'],
      failed: [],
      skipped: [],
    };
  }

  return {
    /** Panel scopes and environment capabilities. */
    async bootstrap() {
      const out = {
        ok: true,
        projects: [],
        globalRoot: null,
        webAvailable: web() !== undefined,
        subprocessAvailable: sp() !== undefined,
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

    /** Descriptions for up to six search results, resolved from the archive. */
    async describe(args) {
      const items = Array.isArray(args && args.items) ? args.items.slice(0, 6) : [];
      const out = {};
      for (const it of items) {
        const key = String(it.source) + '/' + String(it.skillId);
        if (descCache[key] !== undefined) {
          out[key] = descCache[key];
          continue;
        }
        try {
          const d = await fetchDoc(String(it.source), String(it.skillId));
          out[key] = d.ok ? { ok: true, description: parseDescription(d.content) } : { ok: false };
        } catch (e) {
          out[key] = { ok: false };
        }
        descCache[key] = out[key];
      }
      return { ok: true, descriptions: out };
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
      const f = fs();
      if (f === undefined) return { ok: false, error: 'No filesystem service is available.' };
      const agent = resolveAgent(a.sessionId);
      if (agent === undefined) return { ok: false, error: 'No live session is available.' };
      const opts = { scope: agent };
      if (a.projectPath) opts.cwd = String(a.projectPath);
      try {
        const def = await ctx.skills.get(String(a.name), opts);
        if (def === undefined) return { ok: false, error: 'Skill not found.' };
        const p = def.path === undefined ? '' : String(def.path);
        if (p === '') return { ok: false, error: 'This skill has no file to edit.' };
        const dir = dirName(p);
        try {
          const li = await f.lstat(dir);
          if (li !== undefined && li.type === 'symlink') {
            return {
              ok: false,
              error: 'This skill is a link, so its file is shared with another tool and will not be edited here.',
            };
          }
        } catch (e) {
          /* proceed: lstat failure alone is not a reason to refuse */
        }
        const target = await f.resolve(p);
        const updated = withDisableFlag(await f.readText(target), a.enabled !== true);
        if (updated === null) {
          return { ok: false, error: 'This skill has no YAML frontmatter to update.' };
        }
        await f.writeText(target, updated);
        return { ok: true, name: String(def.name), path: p, modelInvocable: a.enabled === true };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    /** Delete a skill, or only the junction when the skill is a link. */
    async uninstall(args) {
      const a = args || {};
      const f = fs();
      if (f === undefined) return { ok: false, error: 'No filesystem service is available.' };
      if (sp() === undefined) return { ok: false, error: 'No subprocess service is available.' };
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
        const dir = dirName(p);

        // Refuse anything outside a root this panel is allowed to own.
        const roots = [];
        const g = await globalRoot();
        if (g !== undefined) roots.push(g);
        if (projectPath) {
          roots.push(pjoin(projectPath, '.dsh/skills'));
          roots.push(pjoin(projectPath, '.agents/skills'));
        }
        const nd = normPath(dir);
        let inside = null;
        for (const r of roots) {
          const nr = normPath(r);
          if (nd !== nr && nd.indexOf(nr + '/') === 0) {
            inside = r;
            break;
          }
        }
        if (inside === null) {
          return { ok: false, error: 'Refusing to remove: not inside a known skills root.' };
        }
        if (src !== 'user-dsh' && src !== 'project-dsh') {
          return { ok: false, error: 'Only skills under a DSH skills root can be removed.' };
        }

        const li = await f.lstat(dir);
        if (li === undefined) return { ok: false, error: 'The skill directory no longer exists.' };
        const isLink = li.type === 'symlink';
        const s = sp();
        const exe = await s.resolveExecutable('cmd.exe');
        // A junction is removed with a plain rmdir; /s would delete the target.
        const argv = isLink ? [exe, '/c', 'rmdir', dir] : [exe, '/c', 'rmdir', '/s', '/q', dir];
        const res = await runCaptured(argv, inside, 15000);
        const still = await f.stat(await f.resolve(dir));
        const rootDir = baseName(dir) === String(def.name) ? dirName(dir) : dir;
        if (still === undefined) {
          try {
            const mf = await readManifest(f, rootDir);
            if (mf.skills[String(def.name)] !== undefined) {
              delete mf.skills[String(def.name)];
              await writeManifest(f, rootDir, mf);
            }
          } catch (e) {
            /* a stale manifest entry is harmless */
          }
        }
        return {
          ok: still === undefined,
          name: String(def.name),
          dir,
          linked: isLink,
          removed: still === undefined,
          detail: still === undefined ? '' : res.err || res.out || '',
        };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    /** Compare every panel-installed skill against its repository copy. */
    async 'check-updates'(args) {
      const a = args || {};
      const f = fs();
      if (f === undefined) return { ok: false, error: 'No filesystem service is available.' };
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
            const mf = await readManifest(f, root);
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
      const f = fs();
      if (f === undefined) return { ok: false, error: 'No filesystem service is available.' };
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
        const mf = await readManifest(f, root);
        const e = mf.skills[name];
        if (e === undefined) {
          return { ok: false, error: 'No recorded source for this skill, so it cannot be updated.' };
        }
        if (String(e.mode) !== 'install') {
          return { ok: false, error: 'This skill was imported, and imported skills are not updated.' };
        }

        const key = String(e.source) + '/' + String(e.skillId);
        delete docCache[key];
        delete descCache[key];
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

    /** Import a skill folder from disk, by junction or by copy. */
    async 'import-skill'(args) {
      const a = args || {};
      const f = fs();
      if (f === undefined) return { ok: false, error: 'No filesystem service is available.' };
      const raw = String(a.sourcePath || '').trim();
      if (raw === '') return { ok: false, error: 'Give the folder that holds the skill (or its SKILL.md).' };
      const mode = a.mode === 'copy' ? 'copy' : 'link';
      try {
        let skillDir = raw;
        let info = null;
        try {
          info = await f.stat(await f.resolve(raw));
        } catch (e) {
          info = null;
        }
        if (info === null) return { ok: false, error: 'Path not found: ' + raw };
        if (info.type === 'file') {
          if (baseName(raw).toLowerCase() !== 'skill.md') {
            return { ok: false, error: 'That file is not a SKILL.md.' };
          }
          skillDir = dirName(raw);
        } else if (info.type !== 'directory') {
          return { ok: false, error: 'Path is neither a folder nor SKILL.md.' };
        }

        const mdPath = pjoin(skillDir, 'SKILL.md');
        let mdText = '';
        try {
          mdText = String(await f.readText(await f.resolve(mdPath)));
        } catch (e) {
          return { ok: false, error: 'No readable SKILL.md inside ' + skillDir };
        }
        const name = parseSkillName(mdText, baseName(skillDir));
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
          return { ok: false, error: 'Could not derive a valid skill name.' };
        }

        const tr = await targetRoot(a);
        if (tr.error) return { ok: false, error: tr.error };
        const destDir = pjoin(tr.root, name);
        try {
          if ((await f.lstat(destDir)) !== undefined) {
            return { ok: false, error: 'Something already exists at ' + destDir };
          }
        } catch (e) {
          /* absent is the expected case */
        }

        let written = [];
        let skipped = [];
        if (mode === 'link') {
          const s = sp();
          if (s === undefined) {
            return { ok: false, error: 'No subprocess service, so a link cannot be created.' };
          }
          const exe = await s.resolveExecutable('cmd.exe');
          const g = await globalRoot();
          await runCaptured([exe, '/c', 'mkdir', tr.root], g === undefined ? tr.root : dirName(g), 8000);
          const r1 = await runCaptured([exe, '/c', 'mklink', '/J', destDir, skillDir], tr.root, 20000);
          let made = await f.lstat(destDir);
          if (made === undefined) {
            // mklink can fail on some volumes; PowerShell's junction cmdlet is
            // the fallback.
            const ps = await resolvePs();
            if (ps !== null) {
              const cmd =
                'New-Item -ItemType Junction -Path ' +
                JSON.stringify(destDir) +
                ' -Target ' +
                JSON.stringify(skillDir) +
                ' -Force | Out-Null';
              await runCaptured([ps, '-NoProfile', '-NonInteractive', '-Command', cmd], tr.root, 25000);
              made = await f.lstat(destDir);
            }
          }
          if (made === undefined) {
            return {
              ok: false,
              error: 'Link creation failed. mklink exit ' + String(r1.code) + (r1.err ? ' | ' + r1.err : ''),
            };
          }
          written = ['(link)'];
        } else {
          const walk = async (srcDir, rel) => {
            const entries = await f.listDir(await f.resolve(srcDir));
            for (const e of entries) {
              const relPath = rel === '' ? e.name : rel + '/' + e.name;
              if (e.type === 'directory') {
                await walk(pjoin(srcDir, e.name), relPath);
                continue;
              }
              // The fs service writes text only, so binary payloads cannot be
              // copied faithfully and are reported instead of corrupted.
              if (e.type !== 'file') {
                skipped.push(relPath);
                continue;
              }
              if (BINARY_EXT.indexOf(extOf(e.name)) >= 0) {
                skipped.push(relPath);
                continue;
              }
              if (e.size !== undefined && e.size > 524288) {
                skipped.push(relPath);
                continue;
              }
              const txt = await f.readText(await f.resolve(pjoin(srcDir, e.name)));
              await f.writeText(await f.resolve(pjoin(destDir, relPath)), txt);
              written.push(relPath);
            }
          };
          await walk(skillDir, '');
          if (written.length === 0) {
            return { ok: false, error: 'Nothing could be copied (all files were binary or too large).' };
          }
        }

        const mf = await readManifest(f, tr.root);
        mf.skills[name] = {
          source: skillDir,
          skillId: name,
          branch: '',
          skillPath: 'SKILL.md',
          hash: hashText(mdText.trim()),
          mode,
          at: String(Date.now()),
        };
        await writeManifest(f, tr.root, mf);
        return {
          ok: true,
          name,
          dir: destDir,
          root: tr.root,
          targetKind: tr.kind,
          mode,
          written,
          skipped,
        };
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },

    /** Search skills.sh. */
    async search(args) {
      const w = web();
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

    /** Destination plus the skill's own SKILL.md, for the details view. */
    async preview(args) {
      const a = args || {};
      const tr = await targetRoot(a);
      const d = await fetchDoc(String(a.source), String(a.skillId));
      if (!d.ok) return { ok: false, error: d.error };
      const text = String(d.content);
      const body = bodyOf(text);
      const nm = d.name === '' ? String(a.skillId) : d.name;
      return {
        ok: true,
        name: nm,
        branch: d.branch,
        skillPath: d.rel === '' ? 'SKILL.md' : d.rel + '/SKILL.md',
        description: parseDescription(text),
        content: body.length > 4000 ? body.slice(0, 4000) + '\n...' : body,
        files: [],
        skipped: [],
        destination: tr.error ? null : pjoin(tr.root, nm),
        targetKind: tr.kind === undefined ? null : tr.kind,
        noteKey: 'viaNote',
        warning: null,
      };
    },

    /** Install one skill from a repository archive. */
    async install(args) {
      const a = args || {};
      if (sp() === undefined) return { ok: false, error: 'No subprocess capability is available.' };
      try {
        return await doInstall(a, false);
      } catch (e) {
        return { ok: false, error: errMsg(e) };
      }
    },
  };
}
