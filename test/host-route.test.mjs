/**
 * dsh-skills-panel — the host route's contract with the platform.
 *
 * Why this file exists. DSH 0.2.3 removed `connection.requestRejection`. The
 * route opened with a call to it, so every request threw inside the handler,
 * the webserver's own catch answered a bare `400` with an empty body, and the
 * panel reported `HTTP 400 with a non-JSON body`. The plugin's own tests could
 * not see it: none of them asked whether the platform still had the API the
 * plugin was written against.
 *
 * So this file checks both what the route registers and what it does when
 * called, and then re-reads the installed DSH to be sure the plugin is not
 * leaning on an API this release no longer has.
 *
 * `node test/host-route.test.mjs` exits non-zero on any failed verdict.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply, inject, CHANNEL } from '../lib/index.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failed = [];
const check = (label, cond, detail) => {
  if (cond) { passed += 1; console.log('ok   ' + label); }
  else { failed.push(label); console.log('FAIL ' + label + (detail === undefined ? '' : '  ' + detail)); }
};

function fakeRes() {
  const state = { status: 0, headers: {}, body: '', ended: false };
  return {
    state,
    set statusCode(v) { state.status = v; },
    get statusCode() { return state.status; },
    setHeader: (k, v) => { state.headers[String(k).toLowerCase()] = v; },
    end: (c) => { state.ended = true; if (c !== undefined) state.body = String(c); },
  };
}

function fakeReq(body = '', headers = {}, method = 'POST') {
  const chunks = body === '' ? [] : [Buffer.from(body, 'utf8')];
  return {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    url: CHANNEL + '/bootstrap',
    [Symbol.asyncIterator]: async function* () { for (const c of chunks) yield c; },
    resume() {},
  };
}

const json = (res) => { try { return JSON.parse(res.state.body); } catch (e) { return null; } };

const ctxWith = (register) => ({
  effect: (fn) => { fn(); return () => {}; },
  webServer: { register },
  skills: { list: async () => [] },
});

// ── registration ────────────────────────────────────────────────────────────
console.log('--- registration ---');
let route = null;
apply(ctxWith((r) => { route = r; return () => {}; }));

check('the route is registered', route !== null);
check('on the prefix the client half calls', route !== null && route.path === CHANNEL, route && route.path);
check('as a prefix route', route !== null && route.kind === 'prefix');
check('declaring auth required', route !== null && route.auth === 'required', route && JSON.stringify(route.auth));
check('with a three-argument handler (req, res, peer)',
  route !== null && typeof route.handler === 'function' && route.handler.length >= 3,
  route && String(route.handler.length));

console.log('\n--- injected services ---');
check('webServer is injected', inject.includes('webServer'));
check('skills is injected', inject.includes('skills'));
// `connection` carried the fence in 0.2.2 and does not exist in 0.2.3.
check('connection is no longer a dependency', !inject.includes('connection'), inject.join(', '));

// ── an admitted caller ──────────────────────────────────────────────────────
const owner = { principal: { kind: 'owner' } };

console.log('\n--- a refused caller ---');
let res = fakeRes();
await route.handler(fakeReq(), res, undefined);
check('an absent Peer is refused', res.state.status === 403, String(res.state.status));
check('with a JSON body, not silence', json(res) !== null && json(res).ok === false, res.state.body);

res = fakeRes();
await route.handler(fakeReq(), res, { principal: { kind: 'guest' } });
check('a non-owner Peer is refused', res.state.status === 403, String(res.state.status));

console.log('\n--- an admitted caller ---');
res = fakeRes();
await route.handler(fakeReq(), res, owner);
check('never answers a bare 400', res.state.status !== 400,
  String(res.state.status) + ' ' + res.state.body.slice(0, 80));
check('answers a JSON envelope', json(res) !== null, res.state.body.slice(0, 80));
check('the envelope is no-store', res.state.headers['cache-control'] === 'no-store');

// ── request shape refusals ──────────────────────────────────────────────────
console.log('\n--- request shape refusals ---');
res = fakeRes();
await route.handler(fakeReq('', {}, 'GET'), res, owner);
check('a GET is method-not-allowed', res.state.status === 405, String(res.state.status));
check('and names the allowed method', res.state.headers.allow === 'POST');

res = fakeRes();
await route.handler(fakeReq('{}', { 'content-type': 'text/plain' }), res, owner);
check('a non-JSON media type is refused', res.state.status === 415, String(res.state.status));

res = fakeRes();
const badPath = fakeReq();
badPath.url = CHANNEL + '/../../etc/passwd';
await route.handler(badPath, res, owner);
check('a malformed endpoint is refused', res.state.status === 404, String(res.state.status));

res = fakeRes();
const unknown = fakeReq();
unknown.url = CHANNEL + '/definitely-not-a-method';
await route.handler(unknown, res, owner);
check('an unknown endpoint is refused', res.state.status === 404, String(res.state.status));
check('and the refusal is a JSON envelope', json(res) !== null && json(res).ok === false);

res = fakeRes();
await route.handler(fakeReq('{not json'), res, owner);
check('a body that is not JSON is a JSON 400', res.state.status === 400 && json(res) !== null,
  String(res.state.status) + ' ' + res.state.body.slice(0, 60));

res = fakeRes();
await route.handler(fakeReq('x'.repeat(300 * 1024)), res, owner);
check('a body past the cap is refused', res.state.status === 413, String(res.state.status));

// ── a method that throws ────────────────────────────────────────────────────
console.log('\n--- a method that throws ---');
let threw = null;
apply(ctxWith((r) => { threw = r; return () => {}; }));
res = fakeRes();
await threw.handler(fakeReq(), res, owner);
check('a throwing method still gets a JSON answer',
  json(res) !== null, String(res.state.status) + ' ' + res.state.body.slice(0, 80));
check('and never leaves a bare empty 400',
  !(res.state.status === 400 && res.state.body === ''),
  String(res.state.status) + ' empty=' + (res.state.body === ''));

// ── against the installed DSH ───────────────────────────────────────────────
console.log('\n--- against the installed DSH ---');
const src = readFileSync(join(pkgRoot, 'lib/index.js'), 'utf8');
check('the route no longer calls requestRejection', !src.includes('requestRejection'));

const candidates = [
  process.env.DSH_PACKAGE_ROOT,
  'C:/Users/chend/scoop/persist/nvm/nodejs/v26.13.1/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
  join(pkgRoot, 'node_modules/@deepseek-ai'),
].filter((p) => typeof p === 'string' && p !== '');

let nm = null;
for (const c of candidates) {
  if (existsSync(join(c, 'dsh-host-webserver/lib/types/index.d.ts'))) { nm = c; break; }
}

if (nm === null) {
  console.log('     (no DSH checkout found; the contract checks are skipped, not passed)');
} else {
  const webserver = readFileSync(join(nm, 'dsh-host-webserver/lib/types/index.d.ts'), 'utf8');
  check('this DSH still documents a route-level auth rule', webserver.includes('WebAuthenticationRule'));
  check('this DSH still passes the Peer to the handler',
    /peer\?: PeerScope\) => void \| Promise/.test(webserver));

  const connPkg = join(nm, 'dsh-client-connection/lib/index.js');
  if (existsSync(connPkg)) {
    check('requestRejection is still absent from Connection',
      !readFileSync(connPkg, 'utf8').includes('requestRejection'),
      'a same-named API returned — re-read it before calling it');
  }
}

console.log('');
if (failed.length > 0) {
  console.error('FAILED: ' + failed.length + ' of ' + (passed + failed.length) + ': ' + failed.join('; '));
  process.exit(1);
}
console.log('OK: ' + passed + " checks — the host route matches this DSH's route contract.");
