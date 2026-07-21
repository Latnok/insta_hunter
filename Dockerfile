FROM node:20-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS test
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY src ./src
COPY db ./db
COPY scripts ./scripts
COPY test ./test
RUN npm run check && npm test

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY db ./db
COPY scripts ./scripts
COPY docs/legacy ./docs/legacy
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
