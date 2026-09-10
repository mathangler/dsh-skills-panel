/**
 * dsh-skills-panel — host half.
 *
 * A Cordis plugin row (`name: 'dsh-skills-panel'`) that exposes the skills
 * panel's JSON methods to its own browser half over the generic Connection RPC
 * channel registry. No Typert code generation is involved, which is what makes
 * this package build-free.
 *
 * All behaviour lives in `host-core.js`; this file only adapts it to the
 * transport, so the same logic could be re-hosted on another carrier.
 *
 * @module dsh-skills-panel
 */
import { createHandlers } from './host-core.js';

/** Cordis plugin name reported to the loader. */
const name = 'skills-panel';

/**
 * `connection` is the host half of `@deepseek-ai/dsh-client-connection`, which
 * owns the RPC route. `skills` is hard-required because every method in
 * host-core resolves the skill scope through it.
 */
const inject = ['connection', 'skills'];

/** Absolute logical RPC channel owned by this plugin; must match the client half. */
const CHANNEL = '/skills-panel';

/** Success envelope required by ConnectionRpcHandler. */
const ok = (value) => ({ ok: true, value });

/** Failure envelope required by ConnectionRpcHandler. */
const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } });

/**
 * Host plugin body: register the channel.
 *
 * The disposer is fiber-owned, so unloading this row removes the HTTP route
 * with it. The handler never throws for a business failure — a thrown handler
 * becomes an opaque HTTP 500, which the panel could only report as a generic
 * transport fault.
 *
 * @param ctx - Host Cordis context.
 */
function apply(ctx) {
  const handlers = createHandlers(ctx);

  ctx.connection.rpc.handle(CHANNEL, async (endpoint, payload, signal) => {
    if (signal !== undefined && signal.aborted) {
      return fail('skills-panel/cancelled', 'caller aborted');
    }
    // Endpoint names are the host-core method names verbatim; `switch`-free
    // dispatch keeps the two halves from drifting when a method is added.
    const fn = Object.prototype.hasOwnProperty.call(handlers, endpoint) ? handlers[endpoint] : undefined;
    if (typeof fn !== 'function') {
      return fail('skills-panel/bad-request', 'unknown endpoint ' + JSON.stringify(endpoint));
    }
    try {
      const args = payload !== null && typeof payload === 'object' ? payload : {};
      return ok(await fn(args));
    } catch (error) {
      return fail('skills-panel/internal', error instanceof Error ? error.message : String(error));
    }
  });
}

export { apply, inject, name, CHANNEL };
