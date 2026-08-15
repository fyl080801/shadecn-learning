FROM --platform=$BUILDPLATFORM harbor-core.harbor.svc/library/node:22-alpine AS build
# better-sqlite3 在 musl 上没有预编译包，得现场编译
RUN apk add --no-cache python3 make g++
RUN npm install -g pnpm@9.15.9
WORKDIR /app
# prisma/ 一起先拷进来，install 的 postinstall 钩子要用 schema 生成 client
COPY package.json pnpm-lock.yaml prisma.config.ts ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile
COPY . .
# COPY 之后再生成一次，确保 server/generated/prisma 是最新 schema 的产物
RUN npx prisma generate
RUN npx vite build
# 运行时只需要生产依赖（tsx / prisma 在 dependencies 里，用来直接跑 server/*.ts 和迁移）
RUN pnpm prune --prod

# 运行时由 Node 统一承载：既提供 /api、/ws，也吐 dist 静态资源
FROM 192.168.68.95:31443/docker.io/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/prisma.config.ts ./prisma.config.ts
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
# SQLite 落在运行目录的 data/ 下，挂卷进来才不会随容器一起没
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000
# 起服务前先把迁移跑上，库文件不存在会自动建
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx server/index.ts"]
