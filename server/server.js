// SBOS-A1-ERP HTTP server — boot entry point.
//
// `start({ app?, port, host, db, pgAdapter, locale })` either uses the
// Express app passed in or builds one via createApp(), then listens
// on the configured port and returns the http.Server handle so the
// caller can close it (tests start + stop the server without leaking
// the port).
//
// Port 0 → OS-assigned random port (used by integration tests).
import { createApp } from './index.js';

/**
 * Start the SBOS HTTP server.
 *
 * @param {object} opts
 * @param {object} [opts.app]  pre-built Express app (skips createApp)
 * @param {number} [opts.port=3000]
 * @param {string} [opts.host='127.0.0.1']
 * @param {object} [opts.db]   raw node:sqlite handle (required if opts.app omitted)
 * @param {object} [opts.pgAdapter] pg-style adapter (required if opts.app omitted)
 * @param {string} [opts.locale='en']
 * @returns {Promise<import('node:http').Server>}
 */
export async function start({
  app: appIn,
  port = 3000,
  host = '127.0.0.1',
  db,
  pgAdapter,
  locale = 'en',
} = {}) {
  const app = appIn || (await createApp({ db, pgAdapter, locale }));

  return await new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', (err) => {
      console.error('[server] listen error:', err && err.message ? err.message : err);
      reject(err);
    });
  });
}
