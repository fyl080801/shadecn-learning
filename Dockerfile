# 源码 → 镜像的一把梭构建。
# 只想拿现成产物打包的话用产物自带的那份（内容和下面两个阶段一致）：
#   pnpm build && docker build -t shadecn-learning ./output
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
# 前端 → output/public，后端 → output/server，外加 package.json / prisma / Dockerfile：
# output/ 本身就是一个完整可运行的 app 目录
RUN pnpm build

# 运行时依赖只从 output/package.json 装（就 hono / prisma / yjs 那几个）。
# 这个阶段不带 --platform，跑在目标平台上，better-sqlite3 编译出来的就是目标架构。
FROM harbor-core.harbor.svc/library/node:22-alpine AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY --from=build /app/output/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 运行时由 Node 统一承载：既提供 /api、/ws，也吐 public/ 静态资源
FROM 192.168.68.95:31443/docker.io/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
COPY --from=deps /app/node_modules ./node_modules
# 只拷产物，源码和构建期依赖都不进运行镜像
COPY --from=build /app/output ./
# SQLite 落在运行目录的 data/ 下，挂卷进来才不会随容器一起没
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000
# 起服务前先把迁移跑上，库文件不存在会自动建
CMD ["sh", "-c", "npx prisma migrate deploy && node server/index.js"]
