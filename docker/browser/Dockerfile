FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && npm cache clean --force

COPY --chown=node:node runtime.mjs healthcheck.mjs smoke.mjs ./
USER node
EXPOSE 3001
CMD ["node", "runtime.mjs"]
