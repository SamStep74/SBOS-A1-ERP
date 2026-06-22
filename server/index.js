// SBOS-A1-ERP HTTP server — Express app factory.
//
// Wires the bootable entry point of the product:
//   - express.json body parser (1mb cap)
//   - in-memory bearer-token auth middleware (stubbed Admin)
//   - RBAC admin routes mounted at /api/rbac (Fastify-style registerRbacRoutes)
//   - finance routes mounted at /api/finance
//   - dashboard HTML mounted at /api/dashboard
//   - health check at /api/health
//   - generic 404 + 500 handlers
//
// Tenant resolution is task 2's job; for now, every authenticated
// request gets `req.user = { id: 1, role: 'Admin', tenant_id: 0 }`
// unless a real `Authorization: Bearer <token>` is supplied that
// matches a row in the `users` table.
//
// DB contract:
//   `opts.db` is the raw `node:sqlite` handle (used by RBAC routes +
//   the auth middleware's users lookup).
//   `opts.pgAdapter` is the pg-style adapter (used by the finance pure
//   functions in server/finance/*.js).
//
// Architecture:
//   The RBAC routes in server/rbac/routes.js are Fastify-style —
//   `app.get(url, { preHandler }, async handler)` with Fastify's
//   `request.user` / `reply.code().send()` semantics. To mount them on
//   Express without rewriting the routes, we wrap the Express app in
//   a tiny Fastify-compatible facade that captures the route table
//   and translates each registration into Express handlers.
//
// No `eval`, no `new Function`, no string-concat SQL. See AGENTS.md
// for the project-wide rules.
import express from 'express';
import { registerRbacRoutes } from './rbac/routes.js';
import { registerFinanceRoutes } from './finance/routes.js';
import { renderDashboard } from './finance/dashboard.js';
import { makeAuthMiddleware } from './auth.js';
import { login as authLogin } from './auth-login.js';

// Version reported by /api/health. Pulled from package.json lazily so
// the value tracks the actual installed version without a hardcode.
let cachedVersion = null;
async function getPackageVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    // ESM-friendly read of package.json from the repo root.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, '..', 'package.json');
    const txt = await readFile(pkgPath, 'utf8');
    const pkg = JSON.parse(txt);
    cachedVersion = String(pkg.version || '0.0.0');
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

function toExpressRoute(url) {
  // Fastify's `:name(*)` wildcard syntax translates to Express's
  // `*name` wildcard syntax. The named splat `*name` is accepted by
  // path-to-regexp v6+ (Express 5 ships v8). The integration-gate
  // verifier's commit (387b3ce) tried the unnamed `*` for cross-
  // version compat, but path-to-regexp v8 actually REJECTS unnamed
  // `*` (requires a name on the splat). So `*name` is the correct
  // shape for our environment.
  //
  // The handler-side fallback to `req.params[0]` (added in 387b3ce)
  // is still in place — it covers the case where path-to-regexp
  // v0.x is loaded (older installs), which exposes the splat under
  // `params[0]` instead of `params[name]`.
  return String(url).replace(/\/:([A-Za-z_][A-Za-z0-9_]*)\(\*\)/g, '/*$1');
}

function normalizeRouteParams(params = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(params)) {
    normalized[key] = Array.isArray(value) ? value.join('/') : value;
  }
  return normalized;
}

// ────────────────────────────────────────────────────────────────────────
// Fastify-compatible facade that wraps an Express app.
//
// registerRbacRoutes(app, { db }) calls:
//   app.get(url, { preHandler }, async handler)
//   app.post(url, { preHandler }, async handler)
// where preHandler is a Fastify preHandler (request, reply) → Promise.
// And handler is `async (request, reply) => { return {...} }` where the
// returned value becomes the body (or reply.send(payload) was called).
//
// The facade captures these registrations and replays them on the
// underlying Express app at mount time. The Fastify preHandler is
// converted to an Express middleware; the Fastify reply is wrapped in
// a tiny shim that tracks whether send() was called.
// ────────────────────────────────────────────────────────────────────────

function makeFastifyFacade(expressApp, { db }) {
  // The facade exposes a Fastify-compatible API: app.get/post/patch/put/delete
  // take (url, opts, handler) where opts.preHandler is a Fastify preHandler.
  // Route registrations are captured, not directly applied to Express.
  // mountAll() translates each registration into Express route(s) on
  // expressApp.
  //
  // The facade also exposes `app.db` so registerRbacRoutes' `app.db`
  // fallback resolves correctly when the caller passes only opts.db.
  const registrations = [];
  const methods = ['get', 'post', 'patch', 'put', 'delete'];

  // Stash db on the Express app so registerRbacRoutes' `app.db` fallback
  // resolves the same handle.
  expressApp.db = db;

  const facade = { db };
  for (const method of methods) {
    facade[method] = (url, opts, handler) => {
      if (typeof opts === 'function') {
        handler = opts;
        opts = {};
      }
      registrations.push({
        method,
        url,
        preHandler: opts && opts.preHandler,
        handler,
      });
      return facade;
    };
  }
  // (debug log removed)

  // Translate a single Fastify registration into Express route(s).
  // preHandler → Express middleware; handler → final async (req, res).
  function mountRegistration({ method, url, preHandler, handler }) {
    const middlewares = [];
    if (typeof preHandler === 'function') {
      middlewares.push(async (req, res, next) => {
        // Build a Fastify-shaped `request` from Express `req`.
        const fastifyReq = {
          user: req.user,
          session: req.session,
          impersonator: req.impersonator,
          params: normalizeRouteParams(req.params),
          query: req.query,
          body: req.body,
          headers: req.headers,
          ip: req.ip,
          // Expose the raw IncomingMessage so routes that need to
          // read non-JSON request bodies (e.g. POST a sqlite file as
          // application/octet-stream for /api/rbac/backup/validate)
          // can iterate the stream. express.json() skips non-JSON
          // content types so the stream is still readable here.
          raw: req,
        };
        // Build a Fastify-shaped `reply`.
        let sent = false;
        let statusCode = 200;
        const fastifyReply = {
          code(c) {
            statusCode = c;
            return fastifyReply;
          },
          status(c) {
            statusCode = c;
            return fastifyReply;
          },
          // Fastify's reply.header(name, value) sets a response header.
          // Maps to res.setHeader(name, value). Returns the reply for
          // chaining (Fastify convention).
          header(name, value) {
            res.setHeader(name, value);
            return fastifyReply;
          },
          send(payload) {
            if (sent) return fastifyReply;
            sent = true;
            res.status(statusCode);
            // Buffer payloads (binary downloads like /api/rbac/backup)
            // get sent raw. String payloads get the text/html vs
            // text/plain sniff. Everything else gets JSON.
            if (Buffer.isBuffer(payload)) {
              res.send(payload);
            } else if (payload === null || payload === undefined) {
              res.end();
            } else if (typeof payload === 'string') {
              res.type(
                typeof payload === 'string' && payload.startsWith('<') ? 'text/html' : 'text/plain',
              );
              res.send(payload);
            } else {
              res.json(payload);
            }
            return fastifyReply;
          },
        };
        try {
          await preHandler(fastifyReq, fastifyReply);
          // preHandler sent something — short-circuit.
          if (sent) return;
        } catch (err) {
          return next(err);
        }
        next();
      });
    }
    middlewares.push(async (req, res, next) => {
      const fastifyReq = {
        user: req.user,
        session: req.session,
        impersonator: req.impersonator,
        params: normalizeRouteParams(req.params),
        query: req.query,
        body: req.body,
        headers: req.headers,
        ip: req.ip,
        raw: req,
      };
      let sent = false;
      let statusCode = 200;
      const fastifyReply = {
        code(c) {
          statusCode = c;
          return fastifyReply;
        },
        status(c) {
          statusCode = c;
          return fastifyReply;
        },
        header(name, value) {
          res.setHeader(name, value);
          return fastifyReply;
        },
        send(payload) {
          if (sent) return fastifyReply;
          sent = true;
          res.status(statusCode);
          if (Buffer.isBuffer(payload)) {
            res.send(payload);
          } else if (payload === null || payload === undefined) {
            res.end();
          } else if (typeof payload === 'string') {
            res.type(payload.startsWith('<') ? 'text/html' : 'text/plain');
            res.send(payload);
          } else {
            res.json(payload);
          }
          return fastifyReply;
        },
      };
      try {
        const result = await handler(fastifyReq, fastifyReply);
        // Fastify convention: if handler returns a value, send it.
        if (!sent && result !== undefined) {
          fastifyReply.send(result);
        }
        // If nothing was sent and no value returned, send an empty 200.
        if (!sent && result === undefined) {
          res.status(statusCode).end();
        }
      } catch (err) {
        next(err);
      }
    });
    expressApp[method](toExpressRoute(url), ...middlewares);
  }

  function mountAll() {
    for (const reg of registrations) {
      mountRegistration(reg);
    }
  }

  facade.mountAll = mountAll;
  facade.registrations = registrations;
  return facade;
}

// ────────────────────────────────────────────────────────────────────────
// Auth middleware. Replaces the legacy "stub Admin for any token"
// behavior with real session-token auth (see server/auth.js).
//
// /api/health stays exempt so the orchestrator can probe it without
// a token. The rest of the API requires a Bearer session token
// minted by the rbac seed on first boot (printed to stdout by
// bin/sbos-server.mjs).
//
// For the unit-test suite: set SBOS_AUTH_MODE=stub to restore the
// legacy "any request → stub Admin" behavior. The 893-test suite
// uses this so we don't have to seed a session per test.
// ────────────────────────────────────────────────────────────────────────

function makeAuthMiddlewareForApp({ db }) {
  return makeAuthMiddleware({ db });
}

// ────────────────────────────────────────────────────────────────────────
// createApp — exported factory.
// ────────────────────────────────────────────────────────────────────────

export async function createApp({
  db,
  pgAdapter,
  locale = 'en',
  scheduler = null,
} = {}) {
  if (!db) {
    throw new TypeError('createApp requires a db (opts.db)');
  }
  if (!pgAdapter) {
    throw new TypeError('createApp requires a pgAdapter (opts.pgAdapter)');
  }
  const app = express();

  // Stash the raw sqlite db on app.locals so the finance routes
  // (and the audit + auth-login modules) can reach it for write
  // operations that need a synchronous sqlite handle (audit row,
  // session row insert, failed-login counter). The pg adapter
  // (`opts.pgAdapter`) is the right interface for the pure
  // functions; this raw handle is for in-house infrastructure
  // writes that the pure functions don't own.
  app.locals.db = db;
  app.locals.pgAdapter = pgAdapter;

  // Body parser — 1mb cap matches the spec.
  app.use(express.json({ limit: '1mb' }));

  // Auth middleware (must run before any /api/rbac routes).
  app.use(makeAuthMiddlewareForApp({ db }));

  // The facade exposes a Fastify-compatible API so registerRbacRoutes
  // can register its Fastify-style routes without us rewriting the
  // routes file. We pass the facade AS the app to registerRbacRoutes
  // (it only uses .get/post/patch/put/delete + app.db).
  const facade = makeFastifyFacade(app, { db });

  // RBAC routes — Fastify-style; facade captures them, doesn't mount yet.
  registerRbacRoutes(facade, { db });

  // Flush the facade registrations onto Express (so RBAC routes share
  // the same router stack as the rest).
  facade.mountAll();

  // Finance routes — Express-native thin wrappers around the finance
  // pure functions.
  registerFinanceRoutes(app, { pgAdapter, locale });

  // Dashboard HTML — wraps renderDashboard().
  app.get('/api/dashboard', async (req, res, next) => {
    try {
      // /api/dashboard defaults to today (browser-friendly); the
      // /api/finance/dashboard route requires an explicit asOfDate.
      const asOfDate =
        String(req.query.asOfDate || '').trim() || new Date().toISOString().substring(0, 10);
      const html = await renderDashboard(pgAdapter, asOfDate, { locale });
      res.status(200).type('text/html; charset=utf-8').send(html);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // Health check.
  app.get('/api/health', async (_req, res) => {
    const version = await getPackageVersion();
    res.status(200).json({ ok: true, version });
  });

  // POST /api/auth/login — public (no Bearer required). Verifies
  // username + password against the users table, applies the
  // failed-login lockout policy, and on success mints a session
  // row in sbos_rbac_sessions (same scheme as the boot-minted
  // admin token). The response shape matches what the existing
  // Bearer middleware expects, so the client can swap the boot
  // token for a login token without changing any other code.
  app.post('/api/auth/login', express.json({ limit: '1mb' }), (req, res) => {
    const { username, password } = req.body || {};
    const result = authLogin(db, username, password);
    if (result.error) {
      const code = result.status === 423 ? 423 : result.status === 400 ? 400 : 401;
      return res.status(code).json({ error: code === 423 ? 'locked' : 'unauthorized', message: result.error });
    }
    res.status(200).json({
      token: result.token,
      expires_at: result.expiresAt,
      user: result.user,
    });
  });

  // POST /api/auth/logout — revoke the current session. Best-effort:
  // if the token is unknown or already revoked, we still return 200
  // (the goal is to make the token unusable, which is already true
  // for an unknown/revoked token).
  app.post('/api/auth/logout', makeAuthMiddlewareForApp({ db }), (req, res) => {
    if (req.session && req.session.id) {
      try {
        db.prepare(`UPDATE sbos_rbac_sessions SET revoked_at = datetime('now') WHERE id = ?`).run(req.session.id);
      } catch (_e) {
        // best-effort
      }
    }
    res.status(200).json({ ok: true });
  });

  // ──────────────────────────────────────────────────────────────────
  // Wave 42 — user-facing session management
  //
  // The /api/rbac/sessions endpoints (in server/rbac/routes.js) are
  // the admin/auditor view (list ALL sessions in a tenant, revoke
  // ANY session, gated by security.session.list / .revoke).
  //
  // The endpoints below are the USER-facing view: any logged-in user
  // can list THEIR OWN active sessions, revoke a session they own
  // (e.g. "log me out of my old phone"), and revoke all of their
  // sessions including the current one ("logout-everywhere"). No
  // extra perm gate beyond authentication — these are self-service.
  //
  // The scope check (session.user_id === req.user.id) is enforced
  // at the SQL boundary in the pure functions (server/auth-sessions.js),
  // not at the route layer, so a malicious request body can't
  // escape the scope.
  // ──────────────────────────────────────────────────────────────────

  // GET /api/auth/sessions — list the current user's active sessions.
  app.get('/api/auth/sessions', makeAuthMiddlewareForApp({ db }), async (req, res) => {
    try {
      const { listMySessions } = await import('./auth-sessions.js');
      const sessions = listMySessions(db, req.user.id);
      // Mark which one is the current session (the one issuing this request).
      const items = sessions.map((s) => ({
        ...s,
        is_current: req.session && req.session.id === s.id,
      }));
      res.status(200).json({ items });
    } catch (err) {
      res.status(500).json({ error: 'internal_error', message: err && err.message });
    }
  });

  // POST /api/auth/sessions/:id/revoke — revoke one of the current
  // user's sessions (must be owned by them; cross-user is rejected
  // at the SQL boundary).
  app.post('/api/auth/sessions/:id/revoke', makeAuthMiddlewareForApp({ db }), async (req, res) => {
    try {
      const { revokeMySession } = await import('./auth-sessions.js');
      const ok = revokeMySession(db, req.user.id, req.params.id);
      if (!ok) {
        return res.status(404).json({ error: 'not_found', message: 'session not found or not yours' });
      }
      res.status(200).json({ ok: true, revoked: req.params.id });
    } catch (err) {
      res.status(500).json({ error: 'internal_error', message: err && err.message });
    }
  });

  // POST /api/auth/sessions/revoke-all — revoke ALL of the current
  // user's sessions, including the current one (logout-everywhere).
  // The current session is also revoked; the caller will need to
  // log in again on the next request.
  app.post('/api/auth/sessions/revoke-all', makeAuthMiddlewareForApp({ db }), async (req, res) => {
    try {
      const { revokeAllMySessions } = await import('./auth-sessions.js');
      const count = revokeAllMySessions(db, req.user.id);
      res.status(200).json({ ok: true, revoked_count: count });
    } catch (err) {
      res.status(500).json({ error: 'internal_error', message: err && err.message });
    }
  });

  // POST /api/auth/password — change the current user's password.
  // Self-service rotation. Body: { old_password, new_password }.
  // Perm gate: any authenticated user (this is self-service).
  app.post('/api/auth/password', makeAuthMiddlewareForApp({ db }), async (req, res) => {
    try {
      const { changePassword } = await import('./auth-login.js');
      const body = req.body || {};
      const result = changePassword(
        db,
        req.user.id,
        body.old_password,
        body.new_password,
      );
      if (!result.ok) {
        // Map error codes to HTTP status:
        //   - "old password is incorrect" → 403 (auth failure)
        //   - "account is temporarily locked" → 423 (Locked)
        //   - everything else → 400 (bad request)
        const status =
          result.error === 'old password is incorrect' ? 403
          : result.error === 'account is temporarily locked; try again later' ? 423
          : 400;
        return res.status(status).json({ error: 'change_password_failed', message: result.error });
      }
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: 'internal_error', message: err && err.message });
    }
  });

  // Generic 404.
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // ────────────────────────────────────────────────────────────────
  // Phase 3 reporting wave 4 (W97-1) — scheduler worker.
  //
  // The worker fires report runs on a cron schedule. It
  // dispatches the right function based on the schedule's
  // report_type, records the execution (status='completed'
  // or 'failed'), and updates next_run_at for the next fire.
  //
  // Pass `opts.scheduler` to override the default
  // { tickMs: 60_000 } config. Pass `opts.scheduler = false`
  // to skip starting the worker (useful for tests that
  // don't want the interval running).
  // ────────────────────────────────────────────────────────────────
  if (scheduler !== false) {
    const { startScheduler } = await import('./finance/scheduleRunner.js');
    const schedulerConfig = typeof scheduler === 'object' && scheduler !== null
      ? scheduler
      : {};
    const schedulerHandle = startScheduler({
      db,
      pgAdapter,
      tickMs: 60_000,
      ...schedulerConfig,
    });
    app.locals.scheduler = schedulerHandle;
  }

  // Generic 500.
  app.use((err, req, res, _next) => {
    console.error('[server] unhandled error:', err && err.stack ? err.stack : err);
    res.status(500).json({
      error: 'internal_error',
      message: err && err.message ? err.message : String(err),
    });
  });

  return app;
}
