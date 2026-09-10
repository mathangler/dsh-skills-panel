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
- **Check all for updates** compares every panel-installed skill against its
  repository and marks the ones that changed.

**Find & install tab**

- Searches skills.sh, shows the upstream description, and previews the SKILL.md
  plus the exact destination before you commit.
- Results you already have are badged **already installed** and offer
  **Reinstall** instead of **Install**.
- Installs to the global skills root or to the current project (`.dsh/skills`).

**Import tab**

- Brings in a skill folder that already exists on disk, either as a **junction**
  (the original folder stays the source of truth) or as a **copy**.
- Imported skills are deliberately excluded from update checks: they have no
  upstream to compare against.

**Updates**

- Once per page load, in the background, every panel-installed skill is checked
  against its repository. Changed skills get a dot and a chip, and the tab title
  gains a count.
- **Update** re-checks first and does nothing when the skill has not changed.

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

Descriptions, previews and update checks read from that same extracted tree, so
`raw.githubusercontent.com` is never required. That matters on networks where it
is unreachable while `codeload` works.

Each installed skill is recorded in `.skills-panel.json` in its skills root with
its repository, branch, in-repo path and a content hash. The manifest is what
makes update checks and clean removals possible; delete it and the panel will
still show the skill, but will not offer updates for it.

---

## Platform notes

- **Windows, macOS and Linux.** There is no shell script and no PowerShell: the
  whole pipeline is Node — `fetch`, `fs.cp`, `fs.symlink`, `fs.rm` — which
  behaves the same on all three. A Windows junction and a POSIX symlink are both
  created with `fs.symlink`, so neither needs elevation.
- **`tar` is the only external tool.** It ships with macOS and Linux, and with
  Windows 10 (1803) and later. You do not need `git`, `curl` or PowerShell.
- The update check compares **SKILL.md content only**. If upstream changes only
  an auxiliary file, the panel reports "up to date". This is a deliberate
  trade-off to keep update checks cheap.

---

## License

MIT — see [LICENSE](LICENSE).
