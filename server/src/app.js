import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { prisma } from './lib/prisma.js';
import { requestId, errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import appRoutes from './routes/app/index.js';
import v1Routes from './routes/v1/index.js';
import { openapi } from './openapi/spec.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(requestId);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // swagger-ui init script
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        // Production runs behind HTTPS; locally (http://localhost) upgrading would break the docs and SPA.
        upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
  }));
  if (!config.isTest) app.use(morgan(config.isProd ? 'combined' : 'dev', { skip: (req) => req.path === '/healthz' }));
  app.use(cookieParser());
  app.use(express.json({ limit: '200kb' }));

  app.get('/healthz', async (_req, res) => {
    try { await prisma.$queryRaw`SELECT 1`; res.json({ status: 'ok' }); } catch { res.status(503).json({ status: 'degraded' }); }
  });

  // Portal API: credentials only from the configured frontend origins.
  const globalLimiter = rateLimit({ windowMs: 60_000, limit: config.isTest ? 10_000 : 300, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'rate_limited', message: 'Too many requests.' } } });
  app.use('/api/app', cors({ origin: config.corsOrigins, credentials: true }), globalLimiter, appRoutes);

  // Integration API: server-to-server; bearer tokens, no cookies, so no credentialed CORS.
  app.use('/api/v1', cors({ origin: false }), v1Routes);

  app.get('/api/openapi.json', (_req, res) => res.json(openapi));
  // Swagger UI references its assets relatively (./swagger-ui.css). Served at /api/docs without
  // the trailing slash, they would resolve to /api/swagger-ui.css and hit the JSON 404 handler,
  // so the page always lives at /api/docs/ (query string kept).
  app.get('/api/docs', (req, res, next) => {
    const [pathname, query] = req.originalUrl.split('?');
    if (pathname.endsWith('/')) return next();
    return res.redirect(301, `${pathname}/${query ? `?${query}` : ''}`);
  });
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: 'CampusCore SIS API', swaggerOptions: { persistAuthorization: false } }));

  // In production, serve the built frontend from the same origin (optional).
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
  if (config.isProd && fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
