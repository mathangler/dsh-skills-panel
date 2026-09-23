# tools — verification scripts

Small, dependency-free scripts used while developing this plugin. They stay out
of the published package (`files[]` in `package.json` lists only `lib/` plus the
patch and READMEs), so they never ship to users.

Each script takes its inputs as arguments and prints a verdict; none hardcode a
machine path, and none touch anything outside the OS temp directory.

## `host-core-check.mjs` — no browser, no DSH, no arguments

Runs the real `createHandlers()` from `lib/host-core.js` against a synthetic
harness home, a mocked Cordis context, a mocked `codeload.github.com` and the
real `tar`. It covers the three failures this panel shipped with:

1. **The global skills root.** It used to come from
   `settings.prepareDocument()`, which is the *profile patch*
   (`<home>/profiles/<name>/cordis.patch.yml`). Its directory is the profile, so
   an install landed in `<home>/profiles/<name>/skills` — a path DSH never
   scans, which is why a freshly installed skill appeared in no list. The root
   must be the one DSH itself reports, and must never be a directory inside a
   profile.
2. **Reinstall.** A search result that is already installed offers Reinstall,
   and the host refused it with `Something already exists at …`. The panel's own
   record has to authorise replacing the folder it installed — and nothing else
   may be replaced, so a hand-written skill of the same name still refuses.
3. **Check for updates.** The extracted `SKILL.md` was memoised by
   `source/skillId` with no expiry, so once a skill had been read in a process,
   every later check compared that first copy: a repository change stayed
   invisible for the life of the server, and the Update button stayed disabled
   behind an "up to date" tag. The memo now belongs to the archive generation
   the TTL re-downloads.

```bash
node tools/host-core-check.mjs
```

It exits non-zero on any failed verdict, and prints the verdicts a broken build
fails on. It exercises `bootstrap`, `list`, `install`, `update`,
`check-updates`, `set-enabled`, `import-skill` and `uninstall` — including the
guards around them: installs land where DSH looks, a project install follows the
`.git` root DSH scopes a cwd to, a foreign folder is never overwritten, an
imported skill is never checked upstream, and removing a link leaves its target
alone.

## Notes

- The archive pipeline is exercised end to end with the real `tar`; a temporary
  local `dsh-skills-panel` cache root keeps one run from answering with a tree
  another run left behind.
- `DSH_HOME` is pointed at the synthetic home for the duration of the run, so
  your own `~/.dsh` is never read or written.
