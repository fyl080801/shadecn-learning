# 画布 agent 的 oci 沙箱镜像（docs/22 §7.2）：每一轮一个容器，里面只跑 runner（pi 推理循环），经网关和服务端说话。
# 由 `pnpm build` 拷进 output/agent-sandbox/，构建上下文就是那个目录（runner/ + 只含 runner 依赖的 package.json）：
#
#   pnpm build:sandbox-image                       # = pnpm build:server + 用 podman / docker 构建本目录
#   podman build -t shadecn-agent-sandbox:latest output/agent-sandbox
#
# 镜像里有什么：node 22（≥ 22.19，pi 1.x 的 engines；只有 node 本体，npm / yarn / corepack 都删了）、ffmpeg / ffprobe、runner 和它的 4 个第三方包
# （@earendil-works/pi-agent-core、@earendil-works/pi-ai、yjs、@dagrejs/dagre），一个非 root 用户 sandbox（10001）。
# **没有**：服务端代码以外的任何源码、数据库驱动、.env、任何密钥（构建上下文里本来就没有）。
#
# 最终阶段是 `FROM scratch` + 整个文件系统拷过去：这样镜像配置里只有下面声明的 PATH，
# node 基础镜像的 NODE_VERSION / YARN_VERSION 不会混进沙箱的环境变量（docs/22 §10 验收 1：环境里只有网关地址与一次性凭证）。
#
# 基础镜像走构建参数，默认是上游官方的引用；要走镜像代理就在构建时传：
#   pnpm build:sandbox-image --build-arg NODE_IMAGE=<代理地址>/docker.io/library/node:22-alpine
# 三个阶段用同一个基础镜像引用，并逐阶段校验架构（单架构 tag + QEMU 会让拉错架构完全不报错，见 docs/12 §2.5.1）。
ARG NODE_IMAGE=docker.io/library/node:22-alpine

# —— 1. 只装 runner 的运行时依赖 ——
FROM ${NODE_IMAGE} AS deps
ARG TARGETARCH
RUN set -e; \
    have=$(node -p "process.arch === 'x64' ? 'amd64' : process.arch"); \
    if [ -n "${TARGETARCH}" ] && [ "${TARGETARCH}" != "$have" ]; then \
      echo "基础镜像是 $have，目标是 ${TARGETARCH} —— 这个 tag 多半没有 ${TARGETARCH} 的 manifest，靠 QEMU 混过去了"; \
      exit 1; \
    fi; \
    echo "base image arch ok: $have ($(uname -m))"
WORKDIR /sandbox
COPY package.json ./
# 全是纯 JS 包，不需要编译；--ignore-scripts：依赖的安装脚本一个都不跑
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && rm -rf /root/.npm

# —— 2. 拼好沙箱的文件系统 ——
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS rootfs
ARG TARGETARCH
RUN set -e; \
    have=$(node -p "process.arch === 'x64' ? 'amd64' : process.arch"); \
    if [ -n "${TARGETARCH}" ] && [ "${TARGETARCH}" != "$have" ]; then \
      echo "基础镜像是 $have，目标是 ${TARGETARCH} —— 这个 tag 多半没有 ${TARGETARCH} 的 manifest，靠 QEMU 混过去了"; \
      exit 1; \
    fi; \
    echo "base image arch ok: $have ($(uname -m))"
# ffmpeg / ffprobe：媒体工具（run_media_command）的白名单命令。
# 删掉 npm / npx / corepack / yarn：沙箱里用不着包管理器。
# sandbox 用户的 home 指向工作目录（容器里是 tmpfs），引擎据此给 HOME；镜像里只建空目录当挂载点。
RUN set -e; \
    apk add --no-cache ffmpeg; \
    ffmpeg -hide_banner -version | head -n 1; \
    ffprobe -hide_banner -version | head -n 1; \
    rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* /usr/local/bin/docker-entrypoint.sh; \
    addgroup -g 10001 sandbox; \
    adduser -D -H -h /work -u 10001 -G sandbox -s /sbin/nologin sandbox; \
    mkdir -p /work
WORKDIR /sandbox
COPY --from=deps /sandbox/node_modules ./node_modules
COPY package.json ./
COPY runner/ ./runner/
# 构建期自检：runner 的 import 全都解析得到。没给环境变量时它应当以退出码 2（缺少环境变量）退出；
# 缺包的话是 1（ERR_MODULE_NOT_FOUND）—— 宁可构建期就失败
RUN set +e; \
    node runner/agent-runner.js > /tmp/selfcheck.log 2>&1; code=$?; \
    cat /tmp/selfcheck.log; rm -f /tmp/selfcheck.log; \
    if [ "$code" != 2 ]; then echo "runner 启动自检失败：退出码 $code（期望 2 = 缺少环境变量）"; exit 1; fi; \
    echo "runner self-check ok"

# —— 3. 最终镜像：只有上一阶段的文件，配置从零写 ——
FROM scratch
COPY --from=rootfs / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LABEL shadecn.agent/managed="true" \
      shadecn.agent/image="sandbox" \
      org.opencontainers.image.title="shadecn agent sandbox" \
      org.opencontainers.image.description="画布 agent 的 runner 沙箱（docs/22 §7.2）"
# 驱动另外显式指定同一个用户，并配只读根文件系统、tmpfs 工作目录、CapDrop ALL、no-new-privileges、资源上限
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["node", "/sandbox/runner/agent-runner.js"]
