# 源码 → 镜像的一把梭构建。
# 只想拿现成产物打包的话用产物自带的那份（内容和下面两个阶段一致）：
#   pnpm build && docker build -t shadecn-learning ./output
#
# ⚠️ 三个阶段的基础镜像必须是**同一个、且真的是多架构的**引用。
# 这里踩过坑：原先 build / deps 用的是 `harbor-core.harbor.svc/library/node:22-alpine`，
# 而 Harbor 的 library 项目里那个 tag 是**只有 arm64 的单架构镜像**（不是代理缓存，
# 是手动推上去的）。`--platform linux/amd64` 对它无能为力，只能退而拉 arm64 —— 而构建机和
# 集群节点都装了 QEMU binfmt，于是它「跑得起来」，没有任何一步报错：
# amd64 那一轮的容器里 `uname -m` 其实是 aarch64，装出来的 better_sqlite3.node 自然也是
# aarch64 的，最后被打包进标着 amd64 的镜像推上线（见 docs/12 §2.5 的护栏说明）。
# 换 tag / 换仓库之前先验一下：在 amd64 节点上跑一次 `uname -m`，必须是 x86_64。
# 基础镜像走构建参数，不写死地址。
#
# 默认值是 Harbor 上 docker.io 的**代理缓存**。它有一个已知的别扭之处：多架构镜像的
# index 是边拉边填的，缓存还没填全时它会把一份**缺架构的 index** 发给客户端，
# buildah 当场报 `no image found in image index for architecture "amd64"` ——
# 一条流水线里前两个 stage 拉得好好的、第三个 stage 就挂了，就是这么回事。
# 缓存热了之后自己就好了，所以**碰上先重试**（Harbor 侧不用动：core / jobservice /
# registry 都已经配了出网代理，实测直连 docker.io 超时、走代理正常）。
#
# 留成参数是为了在重试也不灵的时候有别的路可走：指到一份不经代理缓存的引用
# （Harbor 里自己存的多架构副本，或按 index digest 固定），而 `docker build ./output`
# 保持开箱即用。
#   docker build --build-arg NODE_IMAGE=<引用> ...
ARG NODE_IMAGE=192.168.68.95:31443/docker.io/library/node:22-alpine

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
# better-sqlite3 在 musl 上没有预编译包，得现场编译
RUN apk add --no-cache python3 make g++
RUN npm install -g pnpm@9.15.9
WORKDIR /app
# prisma/ 先拷进来：install 的 postinstall 是 `prisma generate || true`，
# 而 generate 要读 prisma.config.ts → prisma/db-provider.mjs → prisma/<provider>/（schema 目录）。
# 少拷不会让构建失败（|| true 兜住），但日志里会多出一段报错、而且这一步的 generate 白跑
# —— 第 15 行那句显式的 npx prisma generate 是为此留的保险。
#
# ⚠️ `prisma/<provider>/models` 是指向 `prisma/models/` 的**符号链接**。
# docker 的 COPY 会原样保留它（相对链接，拷过去仍然指得对），所以这里不用特殊处理；
# 换成把 prisma/ 打成 tar 再解、或者用 rsync 时要留意别把链接拍平成文件。
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
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS deps
# 拿到的基础镜像必须真的是目标架构 —— 单架构 tag + QEMU 会让「拉错架构」完全不报错，
# 而这个阶段装的是原生模块，错了就一路混进最终镜像。TARGETARCH 由 --platform 推导；
# 万一构建器不提供它（值为空），这里就跳过，不误伤。
ARG TARGETARCH
RUN set -e; \
    have=$(node -p "process.arch === 'x64' ? 'amd64' : process.arch"); \
    if [ -n "${TARGETARCH}" ] && [ "${TARGETARCH}" != "$have" ]; then \
      echo "基础镜像是 $have，目标是 ${TARGETARCH} —— 这个 tag 多半没有 ${TARGETARCH} 的 manifest，靠 QEMU 混过去了"; \
      exit 1; \
    fi; \
    echo "base image arch ok: $have ($(uname -m))"
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY --from=build /app/output/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 运行时由 Node 统一承载：既提供 /api、/ws，也吐 public/ 静态资源
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
# 和 deps 阶段同一道检查：这一层的 node 决定了最终镜像的架构
ARG TARGETARCH
RUN set -e; \
    have=$(node -p "process.arch === 'x64' ? 'amd64' : process.arch"); \
    if [ -n "${TARGETARCH}" ] && [ "${TARGETARCH}" != "$have" ]; then \
      echo "基础镜像是 $have，目标是 ${TARGETARCH} —— 这个 tag 多半没有 ${TARGETARCH} 的 manifest，靠 QEMU 混过去了"; \
      exit 1; \
    fi; \
    echo "base image arch ok: $have ($(uname -m))"
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
COPY --from=deps /app/node_modules ./node_modules
# 只拷产物，源码和构建期依赖都不进运行镜像
COPY --from=build /app/output ./
# 构建期自检：node_modules 里的原生模块必须和这一层的 node 同架构。
# 上面那两道 TARGETARCH 检查管的是「基础镜像对不对」，这道管的是「拼起来对不对」——
# 三个阶段各拉各的基础镜像，只要有一个阶段的架构飘了，混合就发生在这里。
# 出过一次事故：aarch64 的 better_sqlite3.node 进了标着 amd64 的镜像，容器照样起、
# /api/health 也一路 200，直到第一次查库才炸
# 「Error relocating ...: unsupported relocation type 1026」。
# 有了这一行，那种镜像在构建期就失败，而不是推上线之后每个请求 500。
# 逐个 dlopen 而不是 require 某个包名：postgresql 构建里没有 better-sqlite3，
# 而这样写对两种 provider（以及以后新增的原生依赖）都成立。
RUN set -e; \
    found=0; \
    for f in $(find /app/node_modules -name '*.node'); do \
      node -e "process.dlopen({ exports: {} }, process.argv[1])" "$f"; \
      echo "  ok $f"; \
      found=$((found + 1)); \
    done; \
    echo "native modules ok: $found on $(uname -m)"
# SQLite 落在运行目录的 data/ 下，挂卷进来才不会随容器一起没
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000
# 起服务前先把表结构对齐到 schema（db push，没有迁移历史），库文件不存在会自动建。
# 和 scripts/output-image/Dockerfile 保持一致
CMD ["sh", "-c", "npx prisma db push && node server/index.js"]
