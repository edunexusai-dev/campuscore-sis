# CampusCore SIS — server + client (built SPA served by the same Express process)
# Multi-stage: install all deps, build client, prune to production server deps.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY client/package.json ./client/
COPY connector/package.json ./connector/
COPY identity-sync/package.json ./identity-sync/
RUN npm ci

FROM node:22-alpine AS client-build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/client/node_modules ./client/node_modules
COPY package.json ./
COPY client ./client
RUN npm run build --workspace client

FROM node:22-alpine AS prisma
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY package.json ./
COPY server/package.json ./server/
COPY server/prisma ./server/prisma
RUN cd server && npx prisma generate

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY connector/package.json ./connector/
COPY identity-sync/package.json ./identity-sync/
# client is not needed at runtime — it was built in the previous stage
COPY client/package.json ./client/
RUN npm ci --omit=dev

FROM node:22-alpine
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/server/node_modules ./server/node_modules
COPY --from=prisma /app/server/node_modules/.prisma ./server/node_modules/.prisma
COPY package.json ./
COPY server/package.json ./server/
COPY server/prisma ./server/prisma
COPY server/src ./server/src
COPY server/scripts ./server/scripts
COPY --from=client-build /app/client/dist ./client/dist

USER node
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:4000/healthz || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["node", "server/src/server.js"]
