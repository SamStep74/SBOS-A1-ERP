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
          params: req.params,
          query: req.query,
          body: req.body,
          headers: req.headers,
          ip: req.ip,
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
          send(payload) {
            if (sent) return fastifyReply;
            sent = true;
            res.status(statusCode);
            // JSON if payload is an object; raw text otherwise.
            if (payload === null || payload === undefined) {
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
        params: req.params,
        query: req.query,
        body: req.body,
        headers: req.headers,
        ip: req.ip,
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
        send(payload) {
          if (sent) return fastifyReply;
          sent = true;
          res.status(statusCode);
          if (payload === null || payload === undefined) {
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
    expressApp[method](url, ...middlewares);
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
// In-memory auth middleware.
//
// For the bootable entry point we don't have a real auth subsystem yet
// (that's task 2: tenant resolution + JWT/session). We expose a
// minimal Bearer-token middleware that:
//   - reads `Authorization: Bearer <token>` (token === numeric user id)
//   - looks up `users` table by id
//   - sets `req.user = { id, role, tenant_id, org_id, mfa_verified }`
//   - falls back to a stubbed Admin user (id=1) when no token is sent
//
// This keeps the RBAC routes happy (they need `request.user.role`) and
// makes /api/health reachable from the browser without auth wiring.
// ────────────────────────────────────────────────────────────────────────

function makeAuthMiddleware({ db }) {
  return function authMiddleware(req, res, next) {
    // Health check must work without a token (orchestrator probes it).
    if (req.path === '/api/health' || req.path === '/api/health/') {
      req.user = { id: 0, role: 'Admin', tenant_id: 0, mfa_verified: true };
      return next();
    }

    const auth = req.headers.authorization || '';
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (!match) {
      // No token: stub Admin (id=1) — matches the rbac routes' seed user.
      req.user = { id: 1, role: 'Admin', tenant_id: 0, org_id: null, mfa_verified: true };
      return next();
    }
    const token = match[1].trim();
    const userId = Number(token);
    if (!Number.isInteger(userId) || userId <= 0) {
      req.user = { id: 1, role: 'Admin', tenant_id: 0, org_id: null, mfa_verified: true };
      return next();
    }
    try {
      const row = db
        .prepare(
          'SELECT id, username, email, role, tenant_id, org_id, mfa_required, mfa_verified FROM users WHERE id = ?',
        )
        .get(userId);
      if (!row) {
        req.user = { id: 1, role: 'Admin', tenant_id: 0, org_id: null, mfa_verified: true };
        return next();
      }
      req.user = {
        id: Number(row.id),
        username: row.username,
        email: row.email,
        role: row.role,
        tenant_id: Number(row.tenant_id || 0),
        org_id: row.org_id == null ? null : Number(row.org_id),
        mfa_required: !!row.mfa_required,
        mfa_verified: !!row.mfa_verified,
      };
      return next();
    } catch (_err) {
      // users table missing or other DB error — fall back to stub Admin
      // so the server still boots. Real auth wiring replaces this.
      req.user = { id: 1, role: 'Admin', tenant_id: 0, org_id: null, mfa_verified: true };
      return next();
    }
  };
}

// ────────────────────────────────────────────────────────────────────────
// createApp — exported factory.
// ────────────────────────────────────────────────────────────────────────

export async function createApp({ db, pgAdapter, locale = 'en' } = {}) {
  if (!db) {
    throw new TypeError('createApp requires a db (opts.db)');
  }
  if (!pgAdapter) {
    throw new TypeError('createApp requires a pgAdapter (opts.pgAdapter)');
  }
  const app = express();

  // Body parser — 1mb cap matches the spec.
  app.use(express.json({ limit: '1mb' }));

  // Auth middleware (must run before any /api/rbac routes).
  app.use(makeAuthMiddleware({ db }));

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

  // Generic 404.
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

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
