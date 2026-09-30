# 悦安月子中心平台 —— 一键启动镜像
# node:sqlite 需要 Node.js >= 22.5（内置 SQLite，无需额外数据库服务）
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# 数据库文件默认落在 /app/data，通过卷持久化
ENV MCARE_DB=/app/data/mcare.db
RUN mkdir -p /app/data && chown -R node:node /app
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --from=builder --chown=node:node /app/next.config.mjs ./next.config.mjs
USER node
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["npm", "start"]
