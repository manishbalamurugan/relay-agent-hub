# syntax=docker/dockerfile:1

# ---- build stage: compile TypeScript ------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage: production deps + compiled output only -------------------------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
# Default store location; mount a Railway volume at /data to survive redeploys.
RUN mkdir -p /data
ENV DATA_FILE=/data/store.json
# PORT is injected by Railway; the server binds 0.0.0.0:$PORT. No fixed EXPOSE on purpose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
