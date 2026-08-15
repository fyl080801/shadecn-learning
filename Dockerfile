FROM --platform=$BUILDPLATFORM harbor-core.harbor.svc/library/node:22-alpine AS build
RUN npm install -g pnpm@9.15.9
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN npx vite build
# 运行时只需要生产依赖（tsx 在 dependencies 里，用来直接跑 server/*.ts）
RUN pnpm prune --prod

# 运行时由 Node 统一承载：既提供 /api、/ws，也吐 dist 静态资源
FROM 192.168.68.95:31443/docker.io/library/node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server ./server
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["npx", "tsx", "server/index.ts"]
