/**
 * dsh-skills-panel — host half.
 *
 * A Cordis plugin row (`name: 'dsh-skills-panel'`) that publishes one JSON
 * route on the composition's `webServer` and dispatches it onto the method map
 * from `host-core.js`. The plugin is self-contained: it needs no profile patch
 * and no code generation.
 *
 * Why it registers its own route instead of using `connection.rpc.handle(...)`:
 * that helper registers the channel through `owner.webServer`, where `owner` is
 * the Connection service's context. In cordis 4.x a service context is a shadow
 * whose service lookups resolve in the PROVIDER's fiber chain, so `webServer`
 * must be injected by the *connection* row, not by this one — which would mean
 * every user hand-patching the shipped row. Registering directly on our own
 * `webServer` avoids that entirely, and is the pattern the shipped
 * `@deepseek-ai/dsh-host-open-in-app` host plugin uses.
 *
 * Security is not hand-rolled: every request goes through the composition's
 * `connection.requestRejection(req)` first, which applies the platform's
 * Host/Origin fence (anti-DNS-rebinding and anti-cross-site) and its browser
 * login-token check. Only then is a body read or a handler reached.
 *
 * @module dsh-skills-panel
 */
import { createHandlers } from './host-core.js';

/** Cordis plugin name reported to the loader. */
const name = 'skills-panel';

/**
 * `webServer` carries the route; `connection` is the trust fence; `skills` is a
 * hard dependency because every method resolves the skill scope through it.
 */
const inject = ['webServer', 'connection', 'skills'];

/** Absolute route prefix owned by this plugin; must match the client half. */
const CHANNEL = '/skills-panel';

/** Panel requests are small JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 256 * 1024;

/** One endpoint segment: the names host-core exports, and nothing else. */
const ENDPOINT_RE = /^[A-Za-z0-9_$.-]+$/;

/** Success envelope; the client half unwraps `value`. */
const ok = (value) => ({ ok: true, value });

/** Failure envelope; the client half surfaces `error.message`. */
const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } });

/** JSON response. `no-store`: every answer is a live fact about this machine. */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling. */
async function readBoundedBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/**
 * Host plugin body: publish the route.
 *
 * The disposer is fiber-owned, so unloading this row removes the route with it.
 * A business failure is answered as HTTP 200 with a failure envelope — the same
 * convention the platform's own channels use — so the panel can show the reason
 * instead of a generic transport fault.
 *
 * @param ctx - Host Cordis context.
 */
function apply(ctx) {
  const handlers = createHandlers(ctx);

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: CHANNEL,
        handler: async (req, res) => {
          // The platform's fence, first: an untrusted or unauthenticated caller
          // never reaches a handler or a body read.
          const rejection = ctx.connection.requestRejection(req);
          if (rejection !== undefined) {
            res.statusCode = rejection;
            res.end();
            return;
          }

          if (req.method !== 'POST') {
            res.statusCode = 405;
            res.setHeader('allow', 'POST');
            res.end();
            return;
          }

          const mediaType = String(req.headers['content-type'] || '')
            .split(';', 1)[0]
            .trim()
            .toLowerCase();
          if (mediaType !== 'application/json') {
            sendJson(res, 415, fail('skills-panel/bad-request', 'content type must be application/json'));
            return;
          }

          const pathname = new URL(String(req.url), 'http://localhost').pathname;
          const endpoint = pathname.slice(CHANNEL.length).replace(/^\//, '');
          if (!ENDPOINT_RE.test(endpoint)) {
            sendJson(res, 404, fail('skills-panel/bad-request', 'malformed endpoint'));
            return;
          }
          // Dispatch on the method map itself, so the two halves cannot drift
          // apart when a method is added or renamed.
          const fn = Object.prototype.hasOwnProperty.call(handlers, endpoint)
            ? handlers[endpoint]
            : undefined;
          if (typeof fn !== 'function') {
            sendJson(res, 404, fail('skills-panel/bad-request', 'unknown endpoint ' + JSON.stringify(endpoint)));
            return;
          }

          const raw = await readBoundedBody(req);
          if (raw === null) {
            sendJson(res, 413, fail('skills-panel/too-large', 'request body exceeds ' + MAX_BODY_BYTES + ' bytes'));
            return;
          }
          let payload = {};
          if (raw.trim() !== '') {
            try {
              payload = JSON.parse(raw);
            } catch (e) {
              sendJson(res, 400, fail('skills-panel/bad-request', 'body is not valid JSON'));
              return;
            }
          }

          try {
            const args = payload !== null && typeof payload === 'object' ? payload : {};
            sendJson(res, 200, ok(await fn(args)));
          } catch (error) {
            sendJson(res, 200, fail('skills-panel/internal', error instanceof Error ? error.message : String(error)));
          }
        },
      }),
    `dsh-skills-panel: ${CHANNEL} route`,
  );
}

export { apply, inject, name, CHANNEL };
