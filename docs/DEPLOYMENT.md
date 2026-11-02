# Deploying CampusCore SIS

CampusCore is made of three parts: one Node.js API (`server/`), a static web app (`client/`), and PostgreSQL. The connector in `connector/` is a library that the integrating system embeds; it is not part of this deployment.

## 1. Production configuration

Create the server environment in your platform's secret store, not in a committed file:

```env
NODE_ENV=production
PORT=4000
DATABASE_URL=postgresql://campuscore_app:<password>@db.internal:5432/campuscore?schema=public&sslmode=require
JWT_SIGNING_SECRET=<48+ random bytes, base64url>
CLIENT_SECRET_PEPPER=<48+ random bytes, base64url>
PUBLIC_API_URL=https://sis.example.edu
CORS_ORIGINS=https://sis.example.edu
SESSION_TTL_HOURS=8
COOKIE_SECURE=true
TRUST_PROXY=1
```

- Use a dedicated database role with rights on the `campuscore` database only. Run migrations with a separate role if your policy requires it.
- In production the server refuses to start unless `COOKIE_SECURE=true`.
- **Rotating `JWT_SIGNING_SECRET`** invalidates every outstanding integration token. Clients recover automatically by requesting new ones.
- **Rotating `CLIENT_SECRET_PEPPER`** invalidates every client secret, so every client must then be rotated in the admin UI. Plan for this.
- Build the web app with `VITE_SHOW_DEMO_ACCOUNTS=false` so the demo sign-in shortcuts are hidden.

## 2. Build and release

```bash
npm ci
VITE_SHOW_DEMO_ACCOUNTS=false npm run build          # → client/dist
cd server && npx prisma generate && npx prisma migrate deploy   # apply migrations (non-destructive)
NODE_ENV=production node src/server.js                # or your process manager
```

**Do not run `npm run db:seed` against production.** The seed deletes all data, and it refuses to run when `NODE_ENV=production` unless explicitly overridden. Load real institutions, terms and catalog data through the admin UI, or through a reviewed import script.

### Option A: single origin (simplest)

When `NODE_ENV=production` and `client/dist` exists, the API also serves the SPA. Put one HTTPS reverse proxy in front:

```nginx
server {
  listen 443 ssl http2;
  server_name sis.example.edu;
  # ssl_certificate …; ssl_certificate_key …;
  client_max_body_size 1m;
  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

### Option B: separate frontend hosting

Deploy `client/dist` to a static host or CDN, routing all paths to `index.html`. It must reach the API **on the same site**: route `/api/*` from the static host to the API, so the SameSite session cookie keeps working. Set `CORS_ORIGINS` to the frontend origin.

### Process management and scaling

- Run under systemd, PM2, or a container orchestrator. Check health with `GET /healthz`, which returns `{status:"ok"}` when the database is reachable.
- The API is stateless apart from **rate-limit counters**, which are held in process memory. To run more than one instance, configure `express-rate-limit` with a shared store such as `rate-limit-redis`.
- Log stdout and stderr to your aggregator. Access logs use the `combined` format in production.

### Container sketch

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
COPY server/package.json server/
COPY client/package.json client/
COPY connector/package.json connector/
RUN npm ci
COPY . .
RUN VITE_SHOW_DEMO_ACCOUNTS=false npm run build && cd server && npx prisma generate
ENV NODE_ENV=production
EXPOSE 4000
CMD ["sh", "-c", "cd server && npx prisma migrate deploy && node src/server.js"]
```

### AWS reference topology

- **API:** ECS/Fargate (or EC2) in private subnets, behind an ALB with an ACM certificate (HTTPS only, HTTP redirects to HTTPS). Set `PUBLIC_API_URL` to the public hostname (Route 53), for example `https://sis-api.feddrick.edu`. Run at least two tasks, with a Redis-backed rate-limit store.
- **Database:** RDS PostgreSQL in private subnets, **not publicly accessible**, encrypted, with automated backups and PITR. Its security group allows 5432 only from the API's security group.
- **Secrets:** AWS Secrets Manager or SSM Parameter Store, injected through the task role (`JWT_SIGNING_SECRET`, `CLIENT_SECRET_PEPPER`, `DATABASE_URL`).
- **Integration consumers such as EdunexusAI** reach the API over HTTPS only. Use an internal ALB with security-group rules if they share or peer a VPC; otherwise use the public ALB, optionally with an AWS WAF IP allow-list for their egress IPs. See [EDUNEXUSAI_INTEGRATION.md](EDUNEXUSAI_INTEGRATION.md) §11.
- **Environments:** keep development, staging and production on separate deployments, databases, integration clients and secrets.

### Institution configuration and data migrations

- Use `server/scripts/rebrand-institution.js` to re-identify an institution (name, slug, email domains) without changing IDs. It dry-runs by default; add `--apply` to make changes. Take a `pg_dump` first.
- Run schema changes with `prisma migrate deploy` only. Review each generated migration for destructive statements before applying it.
- Migration `20261012091355_feddrick_identity_idempotency` is purely additive. It adds the `ExternalIdentityLink` and `IdempotencyRecord` tables and nullable or defaulted columns, plus hand-written partial unique indexes and a check constraint. Prisma doesn't model those indexes, so if a future `prisma migrate dev` proposes `DROP INDEX "ExternalIdentityLink_active_…"`, remove those lines from the generated migration.

## 3. Database operations

### Migrations

- During development: `npm run db:migrate` (`prisma migrate dev`) creates the SQL migrations under `server/prisma/migrations/`. Commit them.
- In production: run `prisma migrate deploy` only. Never run `migrate dev` or `migrate reset` against production.
- Review generated SQL for destructive statements before release. Take a backup immediately before migrating.

### Backup and recovery

| Practice | Recommendation |
|---|---|
| Continuous protection | Use managed Postgres with point-in-time recovery (WAL archiving), retaining at least 14 days |
| Logical backups | Run `pg_dump -Fc campuscore > campuscore-$(date +%F).dump` nightly, encrypted, copied off-site or cross-region, with a retention schedule (e.g. 35 daily, 12 monthly) |
| Before releases | Take an on-demand snapshot before every migration |
| Restore drills | Restore into a scratch instance each quarter (`pg_restore -d campuscore_restore campuscore-YYYY-MM-DD.dump`), run `prisma migrate status`, and spot-check counts of students, registrations and published grades |
| Recovery objectives | Agree RPO and RTO with the registrar (e.g. RPO ≤ 15 minutes, RTO ≤ 4 hours) and test against them |
| Secrets | Back up the environment secrets separately. Without the pepper, client secrets can't be verified. Without the JWT secret, only outstanding tokens are affected. |

### Housekeeping

- **Expired sessions and old token records:** use **Admin → System health → Purge**, or schedule an equivalent SQL job.
- **`ApiRequestLog` and `AuditEvent` growth:** define a retention policy. Archive audit events rather than deleting them.

## 4. Post-deployment checklist

- [ ] HTTPS only. The HSTS header is present (Helmet sets it in production).
- [ ] `COOKIE_SECURE=true` and `TRUST_PROXY` match the proxy topology.
- [ ] The demo seed **was not** run. The demo accounts don't exist.
- [ ] The web app was built with `VITE_SHOW_DEMO_ACCOUNTS=false`.
- [ ] The initial institution and administrator were created with `npm run bootstrap --workspace server -- --slug <slug> --name "<Institution>" --short <ABBR> --email <admin email> --first <First> --last <Last>`. It prints a one-time password; change it at first sign-in.
- [ ] Policies were reviewed, especially the `api.*` write switches.
- [ ] Backups are configured and a restore has been tested.
- [ ] Monitoring and alerting cover `/healthz`, 5xx rates, and authentication failures.
- [ ] The open items in [SECURITY.md](SECURITY.md) are reviewed before real student data is loaded.
