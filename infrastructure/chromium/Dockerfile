FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
COPY prisma ./prisma
COPY prisma7.config.ts ./
RUN npm run build

FROM node:24-bookworm-slim AS browser
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright ARTIFACT_ROOT=/app/.data/artifacts
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && mkdir -p /app/.data/artifacts \
    && chown -R node:node /app/.data \
    && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src/persistence/migrations ./src/persistence/migrations
USER node
CMD ["node", "dist/workers/browser/main.js"]
