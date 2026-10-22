# Linux runner for the Chromium/Stagehand integration tests (full Chromium with
# extension support, non-root, real sandbox). Dependencies only; mount the source.
FROM node:24-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && npm cache clean --force
WORKDIR /app
USER node
# Copies the read-only source to a writable directory and reuses the image's node_modules.
CMD ["bash", "-c", "mkdir -p /tmp/app && tar -C /src --exclude=./node_modules --exclude=./dist --exclude=./.git -cf - . | tar -C /tmp/app -xf - && ln -sfn /deps/node_modules /tmp/app/node_modules && cd /tmp/app && node --experimental-vm-modules node_modules/jest/bin/jest.js tests/browser tests/config"]
