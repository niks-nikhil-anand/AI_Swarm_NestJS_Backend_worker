FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY src/persistence/migrations ./src/persistence/migrations
RUN mkdir -p /app/.data/artifacts && chown -R node:node /app/.data
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
