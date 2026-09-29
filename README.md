# dsh-skills-panel

English | [中文](README.zh.md)

A **Skills** page for the DeepSeek Harness settings dialog: see every skill DSH
can load — global and per project — search and install new ones from
[skills.sh](https://skills.sh), control which skills are auto-injected into the
model context, and get told when an installed skill changes upstream.

> **Unofficial.** This is a third-party plugin. It is not affiliated with or
> endorsed by DeepSeek. It uses only public DSH plugin surfaces.

---

## What it does

**Installed tab**

- Lists the effective skill set for a scope, with a source badge per skill
  (`user-dsh`, `project-dsh`, a preset, an agent preset, …) and a marker when a
  project skill overrides a global one of the same name.
- A switch per skill: **on** means the skill stays in the model-visible catalog,
  **off** writes `disable-model-invocation: true` into the skill's frontmatter so
  it drops out of the catalog but stays callable as `/name`. That is DSH's own
  mechanism, not a private convention.
- Skills that are junctions into another tool, or that DSH does not own, are
  shown read-only — the panel will not rewrite a file it shares with someone else.
- **View** expands the skill's SKILL.md inline.
- **Remove** deletes the skill folder, or only the link when the skill is a
  junction (a plain `rmdir` cannot follow a junction into its target).
- **Check all for updates** compares every tracked skill against its repository
  and marks the ones that changed.
- A skill the panel did not install — one copied in, or installed by a script —
  offers **Track source**: tell the panel which repository it came from and it
  takes part in checks and updates like any other. See **Updates** below.

**Find & install tab**

- Searches skills.sh and gives each result a **GitHub** and a **skills.sh**
  entry point, so you can inspect it yourself before committing.
  The panel downloads nothing on its own: a skill you have not confirmed never
  lands on this machine, not even a byte.
- Results you already have are badged **already installed** and offer
  **Reinstall** instead of **Install**.
- Installs to the global skills root or to the current project (`.dsh/skills`).

**Import tab**

- Brings in a skill folder that already exists on disk, either as a **junction**
  (the original folder stays the source of truth) or as a **copy**.
- Imported skills are deliberately excluded from update checks: they have no
  upstream to compare against.

**Updates**

- Once per page load, in the background, every tracked skill is checked against
  its repository. Changed skills get a dot and a chip, and the tab title gains a
  count.
- **Update** re-checks first and does nothing at all when upstream has not
  moved — including leaving a locally edited copy untouched.
- The auto/manual model-invocation switch is a setting, not content: flipping it
  never shows up as an edit, never manufactures an update, and **survives an
  update** rather than being reset by it.
- If the local copy no longer matches the baseline it was installed with, the
  panel will not replace it silently: it asks first.
- **Track source** is for skills that came from somewhere other than this panel.
  Search skills.sh by the skill's name and pick the entry, or type `owner/repo`.
  The panel then locates the SKILL.md in that repository and **shows you what it
  found** before anything is written. Attaching baselines what you already have,
  so your own revisions are not immediately reported as a pending update.

---

## Install

Requires DSH with the `web` profile and `pnpm` on `PATH`.

```sh
dsh plugin --profile web add github:mathangler/dsh-skills-panel
```

Then restart the web app:

```sh
dsh web
```

`dsh plugin` runs pnpm inside `~/.dsh/profiles/web` and then appends this package
to `dsh.profile.bundles` automatically, because the package declares
`dsh.bundle`. You do not need to edit any YAML.

Open **Settings → Skills**.

### Update

```sh
dsh plugin --profile web update dsh-skills-panel
```

### Uninstall

```sh
dsh plugin --profile web remove dsh-skills-panel
```

---

## How installing a skill works

Installing does **not** use the GitHub REST API, so it needs no token and is not
subject to the 60-requests-per-hour anonymous limit:

1. The archive is fetched from `codeload.github.com/<repo>/tar.gz/<ref>` — trying
   `HEAD` first, so **no `git` is required**, then `main`, then `master`.
2. `tar` extracts it into a short-lived cache in the system temp directory.
3. The skill directory is located by finding the folder named after the skill id
   that actually contains a `SKILL.md`.
4. `fs.cp` copies it out **whole** — byte for byte, so scripts, images and other
   binary assets come along intact.

**Install and check-for-updates take that pipeline; nothing else does.** Both are
actions you asked for by name. Searching sends no request for a skill's content,
which is the point: a stranger's repository should not appear on your disk before
you have decided anything.

The pipeline needs only `codeload.github.com`, never
`raw.githubusercontent.com`. That matters on networks where `raw` is unreachable
while `codeload` works.

Each tracked skill is recorded in `.skills-panel.json` in its skills root with
its repository, branch, in-repo path and a digest of the **whole skill folder** —
relative paths plus a content hash per file, sorted and combined into one value.
The manifest is what makes update checks and clean removals possible; delete it
and the panel will still show the skill, but will not offer updates for it unless
you track a source again.

The digest answers two questions from one baseline: **has upstream moved**, and
**has this copy been edited**. The second is why an update asks before replacing
anything. A record written by an older version — one that hashed SKILL.md alone,
or that digested the invocation flag — is re-baselined to the current local copy
on its first check, and marked `rebased`.

`disable-model-invocation` in SKILL.md is the one thing left out of the digest,
because it is this panel's own switch rather than part of the skill. Counting it
made flipping a switch read as an edit, and a baseline captured through one
disagreed for good with every repository that does not ship the flag: an update
that updating could never clear. The setting is carried across a reinstall
instead, so refreshing a skill no longer resets it.

---

## Platform notes

- **Windows, macOS and Linux.** There is no shell script and no PowerShell: the
  whole pipeline is Node — `fetch`, `fs.cp`, `fs.symlink`, `fs.rm` — which
  behaves the same on all three. A Windows junction and a POSIX symlink are both
  created with `fs.symlink`, so neither needs elevation.
- **`tar` is the only external tool.** It ships with macOS and Linux, and with
  Windows 10 (1803) and later. You do not need `git`, `curl` or PowerShell.
- The update check covers **the whole skill folder**, not just `SKILL.md`, so a
  release that only touches `scripts/` or a bundled asset is still noticed. The
  digest is path-sorted and separator-normalised, so it is identical on all three
  platforms.
- Tests live in `test/` and are not part of the published package:
  `node test/host-core.test.mjs` and `node test/client-load.test.mjs`.

---

## License

MIT — see [LICENSE](LICENSE).
