/**
 * dsh-skills-panel — the package contract DSH reads before it ever loads us.
 *
 * Two separate audiences read these files, and neither goes through our code:
 *
 *   - the plugin list, which shows a title and a description. `readPluginMeta`
 *     in `@deepseek-ai/dsh-app-boot` resolves `<package>/locale/en.json`
 *     **through the package's `exports` map**, then reads every other `.json` in
 *     that same directory, using the filename as the language id, and takes
 *     `meta.title` / `meta.description` from each. The client then picks one
 *     through the active locale's fallback chain (`zh-CN` → `zh` → `en`).
 *   - npm, which ships whatever `files` lists.
 *
 * Get either wrong and the failure is silent: the list falls back to the bare
 * package name and the English `description`, which looks like nothing is
 * broken. So the rules are asserted here rather than trusted.
 *
 * `node test/plugin-meta.test.mjs` exits non-zero on any failed verdict.
 */
import { readFileSync, readdirSync } from 'node:fs';

const dir = new URL('../', import.meta.url);
const read = (rel) => JSON.parse(readFileSync(new URL(rel, dir), 'utf8'));

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

const pkg = read('package.json');

/** The rule `dsh-app-boot` applies to a locale filename. */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

console.log('--- the package exports and ships its locales ---');
// DSH resolves `<package>/locale/en.json`, so the subpath has to be exported;
// a missing entry makes the resolver throw, and the list silently loses its
// title rather than reporting anything.
check('exports maps the locale subpath',
  pkg.exports !== undefined && pkg.exports['./locale/*.json'] !== undefined,
  JSON.stringify(pkg.exports));
check('files ships the locale directory',
  Array.isArray(pkg.files) && pkg.files.includes('locale/*.json'),
  JSON.stringify(pkg.files));
check('an English description remains as the fallback',
  typeof pkg.description === 'string' && pkg.description.trim() !== '');

console.log('\n--- every locale file is readable and complete ---');
let names = [];
try {
  names = readdirSync(new URL('locale/', dir)).filter((n) => n.endsWith('.json'));
} catch (e) {
  names = [];
}
check('the locale directory exists', names.length > 0);
check('English is present, as DSH requires',
  names.includes('en.json'), names.join(', '));

const dictionaries = new Map();
for (const name of names) {
  const language = name.slice(0, -5);
  check(`${name} uses a language id as its filename`, LANGUAGE_ID.test(language), language);
  let parsed;
  try {
    parsed = read('locale/' + name);
  } catch (e) {
    check(`${name} parses`, false, String(e.message));
    continue;
  }
  const meta = parsed.meta;
  check(`${name} carries a meta object`, meta !== null && typeof meta === 'object' && !Array.isArray(meta));
  if (meta === undefined || meta === null || typeof meta !== 'object') continue;
  // `textOf` rejects anything that is not a non-empty string, so a stray number
  // or an empty string would throw inside the host rather than degrade.
  for (const field of ['title', 'description']) {
    check(`${name} meta.${field} is a non-empty string`,
      typeof meta[field] === 'string' && meta[field].trim() !== '',
      JSON.stringify(meta[field]));
  }
  dictionaries.set(language.toLowerCase(), meta);
}

console.log('\n--- the languages agree with each other ---');
const en = dictionaries.get('en');
const others = [...dictionaries.keys()].filter((k) => k !== 'en');
check('there is at least one translation', others.length > 0, others.join(', '));
for (const language of others) {
  const meta = dictionaries.get(language);
  check(`${language} translates the title`, meta.title !== en.title, meta.title);
  check(`${language} translates the description`, meta.description !== en.description);
}
check('no two languages share a title',
  new Set([...dictionaries.values()].map((m) => m.title)).size === dictionaries.size);

console.log('\n--- the title is a name, not a specifier ---');
// The fallback when nothing is declared is the package name, which is what the
// list showed before these files existed.
check('the title is not just the package name',
  en.title !== pkg.name && en.title.indexOf(pkg.name) === -1, en.title);
check('the description is not the package.json one verbatim',
  en.description !== pkg.description);

console.log('');
if (failed.length > 0) {
  console.error('FAILED: ' + failed.length + ' of ' + (passed + failed.length) + ': ' + failed.join('; '));
  process.exit(1);
}
console.log('OK: ' + passed + ' checks — DSH can find, read and localize the plugin.');
