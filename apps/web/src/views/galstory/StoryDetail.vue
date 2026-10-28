<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useRouter } from "vue-router"
import { ArrowLeft, CircleAlert, GitBranch, TriangleAlert, UserRound } from "@lucide/vue"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import BackendNotice from "@/components/galstory/BackendNotice.vue"
import LintCounts from "@/components/galstory/LintCounts.vue"
import LintList from "@/components/galstory/LintList.vue"

import { cardPreview, countLevels, saveApi, storyApi, structureLabel } from "@/lib/galstory"
import { formatDateTime } from "@/lib/format"
import { usePageTitle } from "@/composables/usePageTitle"
import type { SaveSummary, StoryDetail } from "@/types/galstory"

/**
 * 故事详情（`GET /api/stories/{name}`，**作者面**）。
 *
 * 五个页签对着故事目录的五样东西：story.yaml 的节拍旋钮 · characters/ · stages: ·
 * 该故事的存档 · 作者态体检。
 *
 * 全部**只读**，而且引擎那一侧也只给了读口 —— 改故事是改磁盘上的 yaml。在这里做一个能改的
 * 表单就等于让同一件事有两个说法，而作者手上那份带着注释、还在 git 里。
 */

const props = defineProps<{ storyId: string }>()

const router = useRouter()

/**
 * 称谓宏字面量。**不能直接写在模板里** —— 模板解析器会把 `{{user}}` 的内层花括号
 * 当成插值的起始（eslint 的 vue/no-parsing-error 会当场报出来）。
 */
const USER_MACRO = "{" + "{user}}"

const story = ref<StoryDetail | null>(null)
const saves = ref<SaveSummary[]>([])
const loading = ref(true)
const error = ref<unknown>(null)

usePageTitle("故事", () => story.value?.title ?? null)

async function load() {
  loading.value = true
  error.value = null
  try {
    const [detail, saveList] = await Promise.all([
      storyApi.get(props.storyId),
      saveApi.list(props.storyId)
    ])
    story.value = detail
    saves.value = saveList
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}

watch(() => props.storyId, () => void load(), { immediate: true })

const counts = computed(() => countLevels(story.value?.issues ?? []))

/** 缺了 public_ref 的角色 —— 运行期会降级成真名，是这一页最该先看到的东西 */
const namelessRisk = computed(() => story.value?.characters.filter((c) => !c.publicRef) ?? [])

const policies = computed(() => story.value?.policies ?? null)

const sceneCount = computed(
  () => story.value?.stages.reduce((sum, st) => sum + st.scenes.length, 0) ?? 0
)

/** 提交触发器一个都没配 + 单场景 = 知识永不落库。这条要在概览上直说 */
const neverCommits = computed(() => {
  const p = policies.value
  if (!p) return false
  return p.commitMaxTurns === null && p.commitMaxContext === null && sceneCount.value <= 1
})

const verifyOn = computed(() => {
  const p = policies.value
  if (!p) return []
  return [
    p.verifyRenderRole ? "演员演出" : null,
    p.verifyRenderScene ? "场景渲染" : null,
    p.verifyIntegrate ? "导演汇总" : null,
    p.verifyProposeOptions ? "玩家选项" : null
  ].filter((x): x is string => x !== null)
})
</script>

<template>
  <!-- reka-ui 的 Tooltip 要有 Provider 祖先；本页多处用到，统一套在最外层 -->
  <TooltipProvider>
    <div class="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 p-6">
      <Button variant="ghost" size="sm" class="self-start" @click="router.push('/galstory/stories')">
        <ArrowLeft />
        故事库
      </Button>

      <div v-if="loading" class="flex flex-col gap-4">
        <Skeleton class="h-10 w-64" />
        <Skeleton class="h-64 w-full" />
      </div>

      <BackendNotice v-else-if="error || !story" :error="error ?? '没有这个故事'" @retry="load()" />

      <template v-else>
        <header class="flex flex-col gap-2">
          <div class="flex flex-wrap items-center gap-3">
            <h1 class="text-2xl font-semibold tracking-tight">{{ story.title }}</h1>
            <code class="font-mono text-sm text-muted-foreground">{{ story.name }}</code>
            <Badge variant="secondary">
              {{ structureLabel(story.stages.length, sceneCount) }}
            </Badge>
            <LintCounts :counts="counts" />
          </div>
        </header>

        <Tabs default-value="overview" class="flex min-h-0 flex-1 flex-col gap-4">
          <TabsList>
            <TabsTrigger value="overview">概览</TabsTrigger>
            <TabsTrigger value="characters">角色 {{ story.characters.length }}</TabsTrigger>
            <TabsTrigger value="stages">编制</TabsTrigger>
            <TabsTrigger value="saves">存档 {{ saves.length }}</TabsTrigger>
            <TabsTrigger value="lint">体检</TabsTrigger>
          </TabsList>

          <!-- ── 概览：story.yaml 上那几个节拍旋钮 ────────────────────────── -->
          <TabsContent value="overview" class="flex flex-col gap-4">
            <div v-if="namelessRisk.length > 0" class="flex items-start gap-3 rounded-lg border p-3">
              <TriangleAlert class="mt-0.5 size-4 shrink-0 text-amber-600" />
              <p class="text-sm">
                <span class="font-medium">{{ namelessRisk.map((c) => c.name).join("、") }}</span>
                没有公共指代（public_ref）：不认得他们的视角会降级成真名，「先有观察、后有名字」当场作废。
              </p>
            </div>

            <div v-if="neverCommits" class="flex items-start gap-3 rounded-lg border p-3">
              <CircleAlert class="mt-0.5 size-4 shrink-0 text-amber-600" />
              <p class="text-sm">
                单场景、无转场，又没配 commit 阈值：知识永不落库，角色的心路历程只会停在建档那一条。
              </p>
            </div>

            <div class="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle class="text-base">玩家</CardTitle>
                  <CardDescription>
                    作者态文本里的 <code class="font-mono">{{ USER_MACRO }}</code> 渲染成它
                  </CardDescription>
                </CardHeader>
                <CardContent class="flex flex-col gap-3">
                  <div class="flex items-center gap-2">
                    <UserRound class="size-4 text-muted-foreground" />
                    <span class="font-medium">{{ story.player.label }}</span>
                    <Badge v-if="story.player.label === '你'" variant="outline">第二人称</Badge>
                  </div>
                  <p v-if="story.playerDescription" class="text-sm text-muted-foreground">
                    {{ story.playerDescription }}
                  </p>
                  <Separator />
                  <div class="flex items-center justify-between gap-2 text-sm">
                    <span class="text-muted-foreground">展示层用真名</span>
                    <Badge :variant="policies!.namingTransparent ? 'secondary' : 'outline'">
                      {{ policies!.namingTransparent ? "透明（读者比主角先知道）" : "按玩家的认知" }}
                    </Badge>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle class="text-base">知识</CardTitle>
                  <CardDescription>三层归属由 known_by 分</CardDescription>
                </CardHeader>
                <CardContent>
                  <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                    <div class="flex flex-col">
                      <dt class="text-xs text-muted-foreground">世界公共条目</dt>
                      <dd class="tabular-nums">{{ story.knowledge.worldItems }}</dd>
                    </div>
                    <div class="flex flex-col">
                      <dt class="text-xs text-muted-foreground">公开人物志</dt>
                      <dd class="tabular-nums">{{ story.knowledge.profiles }}</dd>
                    </div>
                    <div class="flex flex-col">
                      <dt class="text-xs text-muted-foreground">私有条目</dt>
                      <dd class="tabular-nums">{{ story.knowledge.privateItems }}</dd>
                    </div>
                    <div class="flex flex-col">
                      <dt class="text-xs text-muted-foreground">关系声明</dt>
                      <dd class="tabular-nums">{{ story.knowledge.relationDecls }}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle class="text-base">提交与压缩</CardTitle>
                  <CardDescription>知识什么时候落库、上下文什么时候压</CardDescription>
                </CardHeader>
                <CardContent>
                  <dl class="flex flex-col gap-3 text-sm">
                    <div class="flex items-center justify-between gap-2">
                      <dt class="text-muted-foreground">轮次阈值</dt>
                      <dd class="tabular-nums">{{ policies!.commitMaxTurns ?? "不设" }}</dd>
                    </div>
                    <div class="flex items-center justify-between gap-2">
                      <dt class="flex items-center gap-1 text-muted-foreground">
                        上下文阈值
                        <Tooltip>
                          <TooltipTrigger as-child>
                            <span class="cursor-help underline decoration-dotted">token</span>
                          </TooltipTrigger>
                          <TooltipContent class="max-w-xs">
                            量的是「本场还没被摘要覆盖的那段剧本线」，不是提示词峰值 ——
                            拿峰值判必然空转。
                          </TooltipContent>
                        </Tooltip>
                      </dt>
                      <dd class="tabular-nums">
                        {{ policies!.commitMaxContext?.toLocaleString() ?? "不设" }}
                      </dd>
                    </div>
                    <div class="flex items-center justify-between gap-2">
                      <dt class="text-muted-foreground">跨场前情</dt>
                      <dd class="tabular-nums">
                        {{
                          policies!.digestPriorScenes === 0
                            ? "关"
                            : `带 ${policies!.digestPriorScenes} 场`
                        }}
                      </dd>
                    </div>
                    <div class="flex items-center justify-between gap-2">
                      <dt class="text-muted-foreground">认知检索 agentloop</dt>
                      <dd>{{ policies!.agentloop ? "开" : "关" }}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle class="text-base">角色间认知</CardTitle>
                  <CardDescription>相识与称呼、心路历程各走各的节拍</CardDescription>
                </CardHeader>
                <CardContent>
                  <dl class="flex flex-col gap-3 text-sm">
                    <div class="flex items-center justify-between gap-2">
                      <dt class="text-muted-foreground">相识与称呼</dt>
                      <dd>{{ policies!.relationEvery === "turn" ? "每轮" : "跟提交" }}</dd>
                    </div>
                    <div class="flex items-center justify-between gap-2">
                      <dt class="text-muted-foreground">场内心路历程</dt>
                      <dd class="tabular-nums">
                        {{
                          policies!.relationDigestEveryTurns === 0
                            ? "关（只跟提交）"
                            : `每 ${policies!.relationDigestEveryTurns} 轮`
                        }}
                      </dd>
                    </div>
                    <div class="flex items-center justify-between gap-2">
                      <dt class="text-muted-foreground">轨迹基线条数</dt>
                      <dd class="tabular-nums">{{ policies!.relationTraceBaseline }}</dd>
                    </div>
                    <div class="flex items-center justify-between gap-2">
                      <dt class="text-muted-foreground">给玩家看轨迹正文</dt>
                      <dd>{{ policies!.relationShowTracesToPlayer ? "开" : "关" }}</dd>
                    </div>
                  </dl>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle class="text-base">输出核验</CardTitle>
                <CardDescription>
                  分 agent 粒度。判据就是生成时的机制约束原文，不符则带 violations 重生一次
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div v-if="verifyOn.length > 0" class="flex flex-wrap gap-1.5">
                  <Badge v-for="name in verifyOn" :key="name" variant="secondary">{{ name }}</Badge>
                </div>
                <p v-else class="text-sm text-muted-foreground">
                  全关。核验有判别力，但每次要带上判据与全部旁证 —— 是不是值得由跑的人决定。
                </p>
              </CardContent>
            </Card>
          </TabsContent>

          <!-- ── 角色 ──────────────────────────────────────────────────── -->
          <TabsContent value="characters">
            <div class="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>角色</TableHead>
                    <TableHead class="w-64">公共指代</TableHead>
                    <TableHead class="w-24 text-right">私有条目</TableHead>
                    <TableHead class="w-40">谁认得他</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="character in story.characters" :key="character.id">
                    <TableCell>
                      <div class="flex items-center gap-2">
                        <span class="font-medium">{{ character.name }}</span>
                        <code class="font-mono text-xs text-muted-foreground">
                          {{ character.id }}
                        </code>
                      </div>
                      <div class="line-clamp-2 text-xs text-muted-foreground">
                        {{ cardPreview(character.description) }}
                      </div>
                    </TableCell>
                    <TableCell>
                      <template v-if="character.publicRef">
                        <span class="text-sm">{{ character.publicRef }}</span>
                        <div v-if="!character.hasProfile" class="text-xs text-muted-foreground">
                          没有公开人物志
                        </div>
                      </template>
                      <div v-else class="flex items-center gap-1.5 text-sm text-amber-600">
                        <TriangleAlert class="size-3.5 shrink-0" />
                        缺 —— 会降级成真名
                      </div>
                    </TableCell>
                    <TableCell class="text-right tabular-nums">
                      {{ character.privateItems }}
                    </TableCell>
                    <TableCell>
                      <div v-if="character.knownBy.length > 0" class="flex flex-wrap gap-1">
                        <Badge v-for="who in character.knownBy" :key="who" variant="outline">
                          {{ who }}
                        </Badge>
                      </div>
                      <span v-else class="text-xs text-muted-foreground">
                        没写 —— 由建档期推断
                      </span>
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <!-- ── 编制：舞台 → 场景 ─────────────────────────────────────── -->
          <TabsContent value="stages" class="flex flex-col gap-4">
            <p
              v-if="story.stages.length === 0"
              class="rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
            >
              这个故事没写 <code class="font-mono">stages:</code>，引擎会自动包一个默认单场景 ——
              没有转场，也就没有回退点。
            </p>

            <Card v-for="stage in story.stages" :key="stage.id">
              <CardHeader>
                <CardTitle class="flex items-center gap-2 text-base">
                  {{ stage.name }}
                  <code class="font-mono text-xs text-muted-foreground">{{ stage.id }}</code>
                </CardTitle>
                <CardDescription>{{ stage.brief || `${stage.scenes.length} 场` }}</CardDescription>
              </CardHeader>
              <CardContent class="flex flex-col gap-4">
                <div
                  v-for="scene in stage.scenes"
                  :key="scene.id"
                  class="flex flex-col gap-3 rounded-lg border p-4"
                >
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-medium">{{ scene.name }}</span>
                    <code class="font-mono text-xs text-muted-foreground">{{ scene.id }}</code>
                    <Badge v-if="!scene.hasOpening" variant="outline">无开场白</Badge>
                    <Badge v-if="scene.resetCognition.length > 0" variant="secondary">
                      认知重置 · {{ scene.resetCognition.join("、") }}
                    </Badge>
                  </div>

                  <!-- goal 与 end_when 并排放，是为了让「死锁」看得见：判定器认 end_when，
                       而**导演看不见它** —— 收尾事件没写进 goal 就永远不会被排出来 -->
                  <div class="grid gap-3 md:grid-cols-2">
                    <div class="flex flex-col gap-1">
                      <span class="text-xs text-muted-foreground">goal（导演读得到）</span>
                      <p class="text-sm">{{ scene.goal || "未写" }}</p>
                    </div>
                    <div class="flex flex-col gap-1">
                      <span class="flex items-center gap-1 text-xs text-muted-foreground">
                        end_when（只有判定器读得到）
                        <Tooltip>
                          <TooltipTrigger as-child>
                            <TriangleAlert class="size-3 cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent class="max-w-xs">
                            导演看不见这一条。要以某个特定事件收尾，就必须把那个事件同时写进 goal
                            —— 否则判定器等着它，而导演不知道要排。
                          </TooltipContent>
                        </Tooltip>
                      </span>
                      <p class="text-sm">{{ scene.endWhen || "不设 —— 只认自然收束" }}</p>
                    </div>
                  </div>

                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="text-xs text-muted-foreground">在场：</span>
                    <Badge v-for="cid in scene.present" :key="cid" variant="outline">
                      {{ cid }}
                    </Badge>
                    <span v-if="scene.present.length === 0" class="text-xs text-muted-foreground">
                      无角色登场（纯场景 agent 推进）
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <!-- ── 存档 ──────────────────────────────────────────────────── -->
          <TabsContent value="saves">
            <div
              v-if="saves.length === 0"
              class="flex flex-col items-center gap-2 rounded-lg border border-dashed p-12 text-center"
            >
              <GitBranch class="size-8 text-muted-foreground" />
              <p class="text-sm text-muted-foreground">这个故事还没有存档</p>
            </div>

            <div v-else class="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>存档</TableHead>
                    <TableHead class="w-64">玩到哪了</TableHead>
                    <TableHead class="w-24">版本后端</TableHead>
                    <TableHead class="w-44">建于</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow v-for="save in saves" :key="save.id">
                    <TableCell>
                      <div class="flex items-center gap-2">
                        <span class="font-medium">{{ save.title || save.id }}</span>
                        <!-- 「在内存里跑着」是引擎的运行态，不是存档的属性 —— 它会随服务重启消失 -->
                        <Badge v-if="save.open" variant="secondary">已装配</Badge>
                      </div>
                      <code class="font-mono text-xs text-muted-foreground">{{ save.id }}</code>
                    </TableCell>
                    <TableCell class="text-sm">
                      <!-- label 是引擎拼好的一句话：进度**现读文件系统**，前端别自己再拼一遍 -->
                      <span v-if="save.progress.started">{{ save.progress.label }}</span>
                      <span v-else class="text-muted-foreground">还没开跑</span>
                    </TableCell>
                    <TableCell>
                      <Badge :variant="save.backend === 'git' ? 'secondary' : 'outline'">
                        {{ save.backend === "git" ? "git" : "复制（降级）" }}
                      </Badge>
                    </TableCell>
                    <TableCell class="text-sm text-muted-foreground">
                      {{ formatDateTime(save.created) }}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </TabsContent>

          <!-- ── 体检 ──────────────────────────────────────────────────── -->
          <TabsContent value="lint">
            <LintList :issues="story.issues" empty-text="作者态体检没有发现问题。" />
          </TabsContent>
        </Tabs>
      </template>
    </div>
  </TooltipProvider>
</template>
