FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
COPY prisma ./prisma
COPY prisma7.config.ts ./
RUN npm run build

FROM node:24-bookworm-slim AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src/persistence/migrations ./src/persistence/migrations
USER node
CMD ["node", "dist/workers/searxng/main.js"]
