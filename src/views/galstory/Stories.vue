<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue"
import { useRouter } from "vue-router"
import {
  BookOpen,
  Copy,
  History,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Play,
  Plus,
  Search,
  Settings2,
  Trash2,
  TriangleAlert
} from "@lucide/vue"
import { toast } from "vue-sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import BackendNotice from "@/components/galstory/BackendNotice.vue"
import ProgressDialog from "@/components/galstory/ProgressDialog.vue"
import NewStoryDialog from "@/components/galstory/NewStoryDialog.vue"

import { useAsyncAction } from "@/composables/useAsyncAction"

import { GalStoryError, runApi, saveApi, storyApi, structureLabel } from "@/lib/galstory"
import type { Quota, StoryScope, StorySummary } from "@/types/galstory"

/**
 * 故事库 —— GalStory 的入口页。
 *
 * **这一页只列故事模板**，不列存档。两者是两种东西：故事是作者态的模板目录，存档是
 * `<storage>/<story>/<save-id>/`，里面**冻结了模板的一份整副本**（改模板不影响进行中的存档）。
 * 混进同一张表的两个筛选项就会把这条最要紧的语义藏起来 —— 存档挂在各自故事的详情页里。
 *
 * ⚠️ **这里没有故事简介，是刻意的，不是接口没做完**：引擎的选单口除 `title` 外一个字都不给，
 * 因为 `StorySpec` 其余字段「仅导演可见」（里面有 `core_conflict`/`ending`）。要看那些去详情页
 * ——那条口是作者面的。
 *
 * 搜索也在本地做：故事是几个到几十个的量级，一个 `?keyword=` 参数换来的是引擎那一侧多一条
 * 要维护的判据，而它对结果没有任何影响。
 *
 * ## 公共库与「我的故事」是同一张表的两个作用域
 *
 * ⚠️ **不开第二个页面**：`scope` 是这条口上的一个过滤器（`all|public|mine`），
 * 而「我能玩哪些故事」只该有一个答案——同一个问题两处声明正是这两个仓库反复栽过的形态。
 *
 * ⚠️ **「只有我看得到我的故事」不是这里过滤出来的**：属主隔离在服务端那一层就成立了
 * （每条转发带 `X-Gal-Owner`，引擎按属主分目录、写口的 base 里根本没有别人的东西）。
 * 这里的 tab 只是让人分栏看；`writable` 那一格也只是把按钮画灰，**不是判据**。
 *
 * ⚠️ **`playable` 是引擎现算的**，不是一个存储字段（存 `status: draft|ready` 就是存一个会漂的
 * 判据——作者在磁盘上改一行、字段还写着 ready）。故这里只如实显示，不缓存、不自己推。
 *
 * ## 每行两个动作
 *
 * **新开始** = 建一个新存档再进对局；**读进度** = 弹出这个故事下**我**玩过的实例。
 * 「我的」这件事在服务端那一层就成立了（每条转发带 `X-Gal-Owner: <登录用户 id>`，引擎按属主
 * 分存档目录），故这一页没有任何按用户过滤的代码 —— 在前端再滤一次既是两处声明，也挡不住谁。
 *
 * ⚠️ 整行是可点的（进详情页），故行内每个按钮都要 `@click.stop`，否则点「新开始」会顺带跳走。
 *
 * ## 「进行中」怎么来的
 *
 * 轮询 `GET /runs`（只读、零成本）。⚠️ **不能拿 `SaveSummary.open` 判**：那个说的是「装配过、
 * 还在引擎内存里」，一局玩完放在那儿仍是 true —— 拿它当进行中，每一局都会显示成在跑。
 *
 * 并发上限也由那条口给（`GAL_SERVER_MAX_CONCURRENT_RUNS`）。**前端不写死这个数**：写死就是
 * 同一个判据两处声明，改了部署配置这边不会有任何东西提醒。满了就把「新开始」禁掉并说清楚 ——
 * 让人点下去再吃一个 429，比不让点更糟。
 */

const router = useRouter()

const items = ref<StorySummary[]>([])
const loading = ref(true)
const error = ref<unknown>(null)

const keyword = ref("")

/**
 * 看哪一档。⚠️ **它是同一条口上的过滤器**（`GET /stories?scope=`），不是第二个页面；
 * 计数在本地按 `scope` 字段算，故切 tab 不重新发请求。
 */
const scope = ref<"all" | StoryScope>("all")

async function load() {
  loading.value = true
  error.value = null
  try {
    // 恒取 `all`：三档的内容是同一份数据的子集，分三次请求只会让计数与列表可能不同步
    items.value = await storyApi.list("all")
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}

void load()

const mineCount = computed(() => items.value.filter((s) => s.scope === "mine").length)
const publicCount = computed(() => items.value.length - mineCount.value)

// ── 我的故事：新建 / 改名 / 删除 ──────────────────────────────────────────────

/** 新建弹窗开着没有；`from` 非空 = 「复制这个故事」那条路 */
const creating = ref<{ open: boolean; from: StorySummary | null }>({ open: false, from: null })

/**
 * 待删的那个故事，以及引擎那句「有几个存档基于它」。
 *
 * ⚠️ **那句话要引擎来说，前端不自己数**：`saves` 那一格是选单里的计数，而删除口拒绝时
 * 回的是它当场算的那个数 —— 让界面自己拼一句，就是同一个事实两处声明。故这里先发一次
 * **不带 confirm** 的删除，把它的 400 原样显示出来，人确认之后再发真正的那一发。
 */
const removing = ref<{ story: StorySummary; detail: string } | null>(null)

const { run: askRemove, isPending: asking } = useAsyncAction(
  async (story: StorySummary) => {
    const hint = await storyApi.confirmHint(story.name)
    if (!hint) {
      // 引擎不再要求确认时它就真删了 —— 如实刷新，别再弹一个确认框
      toast.success(`已删除《${story.title}》`)
      await load()
      return
    }
    removing.value = { story, detail: hint }
  },
  { key: (story: StorySummary) => story.name, errorMessage: "删除失败" }
)

const { run: confirmRemove, pending: removingNow } = useAsyncAction(
  async () => {
    const target = removing.value
    if (!target) return
    await storyApi.remove(target.story.name)
    toast.success(`已删除《${target.story.title}》`)
    removing.value = null
    await load()
  },
  { errorMessage: "删除失败" }
)

/** 封面地址给了却加载不出来的那些（外链会挂、会改）—— 落回占位，别留一个碎图标 */
const broken = ref<Record<string, boolean>>({})

/** 「读进度」弹窗当前对着哪个故事 */
const progressFor = ref<StorySummary | null>(null)

// ── 谁在跑 ────────────────────────────────────────────────────────────────
const quota = ref<Quota>({ limit: 1, running: [] })

/** story 名 → 那一局在跑的 run（一个故事同时跑两局的话取先到的那个） */
const runningByStory = computed(() => {
  const map = new Map<string, Quota["running"][number]>()
  for (const run of quota.value.running) {
    if (run.story && !map.has(run.story)) map.set(run.story, run)
  }
  return map
})

const atLimit = computed(() => quota.value.running.length >= quota.value.limit)

async function pollRuns() {
  try {
    quota.value = await runApi.list()
  } catch {
    // 轮询失败不该弹 toast 打扰人 —— 下一拍会再试；页面主体本来就还在
  }
}

// 3 秒一拍：一轮几十秒，这个粒度足够看出状态变化，又不至于把日志刷满
const timer = window.setInterval(() => void pollRuns(), 3000)
void pollRuns()
onBeforeUnmount(() => window.clearInterval(timer))

/**
 * 新开一局：建存档 → 进对局界面。
 *
 * ⚠️ **建存档这一步还没花钱**（只是把模板整份复制进存档目录）；建档那几十次模型调用发生在
 * 对局页的 `open`。故这里失败了不会留下一个烧过钱的半成品。
 *
 * `key` 按故事名分槽：点 A 的按钮不该把 B 那行也禁掉。
 */
const { run: startNew, isPending: starting } = useAsyncAction(
  async (story: StorySummary) => {
    if (atLimit.value) {
      toast.error(`最多同时开 ${quota.value.limit} 局，先玩完或等一局跑完`)
      return
    }
    const save = await saveApi.create(story.name)
    toast.success(`已为《${story.title}》开一局`)
    void router.push(`/galstory/play/${save.id}`)
  },
  {
    key: (story: StorySummary) => story.name,
    // 配额那条是 429 且带机读的 code —— **按 code 分流，别去匹配文案**
    onError: (err) => {
      if (err instanceof GalStoryError && err.code === "too_many_runs") {
        toast.error(err.message)
        void pollRuns()
        return
      }
      toast.error(err instanceof Error ? err.message : "开局失败")
    }
  }
)

const shown = computed(() => {
  const word = keyword.value.trim().toLowerCase()
  return items.value.filter((s) => {
    if (scope.value !== "all" && s.scope !== scope.value) return false
    if (!word) return true
    return s.name.toLowerCase().includes(word) || s.title.toLowerCase().includes(word)
  })
})
</script>

<template>
  <div class="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 p-6">
    <header class="flex items-start gap-4">
      <div class="flex-1">
        <h1 class="text-2xl font-semibold tracking-tight">故事库</h1>
        <p class="text-sm text-muted-foreground">
          作者态的故事模板。开一局会把模板整份复制进存档，此后改模板不影响进行中的那一局。
        </p>
      </div>
      <div class="flex items-center gap-3">
        <!-- 满了要在**点之前**就说清楚。上限由引擎给，这里不写死 -->
        <span v-if="quota.running.length" class="text-xs text-muted-foreground">
          {{ quota.running.length }} / {{ quota.limit }} 局在跑
        </span>
        <Button variant="outline" @click="router.push('/galstory/config')">
          <Settings2 />
          模型配置
        </Button>
        <Button @click="creating = { open: true, from: null }">
          <Plus />
          新建故事
        </Button>
      </div>
    </header>

    <div v-if="loading" class="flex flex-col gap-2">
      <Skeleton v-for="i in 4" :key="i" class="h-14 w-full" />
    </div>

    <BackendNotice v-else-if="error" :error="error" @retry="load()" />

    <template v-else>
      <div class="flex flex-wrap items-center gap-3">
        <!-- ⚠️ **一个口一个答案**：这是 `GET /stories?scope=` 的过滤器，不是三个页面 -->
        <Tabs v-model="scope">
          <TabsList>
            <TabsTrigger value="all">全部 {{ items.length }}</TabsTrigger>
            <TabsTrigger value="mine">我的 {{ mineCount }}</TabsTrigger>
            <TabsTrigger value="public">公共 {{ publicCount }}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div class="relative max-w-sm flex-1">
          <Search
            class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input v-model="keyword" placeholder="搜索故事名称或 id" class="pl-9" />
        </div>
      </div>

      <div
        v-if="shown.length === 0"
        class="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center"
      >
        <BookOpen class="size-8 text-muted-foreground" />
        <p class="text-sm text-muted-foreground">
          <!-- ⚠️ 「搜不到」「我还没写过」「一个故事都没有」是三件事，修法完全不同 -->
          {{
            keyword
              ? "没有匹配的故事"
              : scope === "mine"
                ? "你还没写过故事——新建一个，或者从公共故事复制一份来改"
                : "故事目录里还没有故事"
          }}
        </p>
        <Button v-if="!keyword && scope === 'mine'" @click="creating = { open: true, from: null }">
          <Plus />
          新建故事
        </Button>
      </div>

      <!-- ⚠️ **列表不是表格**：一个故事是一件「作品」，封面 + 标题 + 一行元信息比一行单元格
           更接近它本来的样子；而「角色几个、几场」这种数字塞进表头只会把注意力从作品上引开。 -->
      <ul v-else class="flex flex-col gap-3">
        <li
          v-for="story in shown"
          :key="story.name"
          class="flex cursor-pointer items-center gap-4 rounded-lg border p-3 hover:bg-muted/50"
          @click="router.push(`/galstory/stories/${story.name}`)"
        >
          <!-- 封面。作者没给地址就用占位 —— **占位在这一层生成**，引擎只如实说「给没给」 -->
          <div
            class="relative size-20 shrink-0 overflow-hidden rounded-md border bg-muted"
          >
            <img
              v-if="story.cover"
              :src="story.cover"
              :alt="story.title"
              class="size-full object-cover"
              loading="lazy"
              @error="broken[story.name] = true"
            >
            <!-- ⚠️ 地址给了但加载失败也要落回占位：外链会挂、会改，塞一个碎图标在那儿更糟 -->
            <div
              v-if="!story.cover || broken[story.name]"
              class="flex size-full items-center justify-center"
            >
              <ImageIcon class="size-6 text-muted-foreground/40" />
            </div>
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="truncate font-medium">{{ story.title }}</span>
              <code class="font-mono text-xs text-muted-foreground">{{ story.name }}</code>
              <Badge v-if="story.scope === 'mine'" variant="outline">我的</Badge>
              <!-- ⚠️ **不可开局是现算的**（引擎那侧 `playable_blockers`），不是一个状态字段。
                   点进去看「哪几条挡着」——那正是编辑页顶上那块。 -->
              <Badge
                v-if="!story.playable"
                variant="destructive"
                class="cursor-pointer gap-1"
                title="这个故事现在开不了局，点击查看是哪几条挡着"
                @click.stop="router.push(`/galstory/stories/${story.name}/edit`)"
              >
                <TriangleAlert class="size-3" />
                不可开局
              </Badge>
              <Badge
                v-if="runningByStory.get(story.name)"
                variant="secondary"
                class="cursor-pointer gap-1"
                :title="`已经跑了 ${Math.round(runningByStory.get(story.name)!.elapsed)} 秒，点击回到这一局`"
                @click.stop="router.push(`/galstory/play/${runningByStory.get(story.name)!.saveId}`)"
              >
                <Loader2 class="size-3 animate-spin" />
                进行中
              </Badge>
            </div>
            <p class="mt-1 truncate text-xs text-muted-foreground">
              {{ structureLabel(null, story.scenes) }} · {{ story.characters }} 个角色 ·
              {{ story.saves }} 份存档
            </p>
          </div>

          <!-- ⚠️ 整行可点（进详情），故这两个都要 @click.stop -->
          <div class="flex shrink-0 gap-2">
            <Button
              v-if="runningByStory.get(story.name)"
              size="sm"
              @click.stop="router.push(`/galstory/play/${runningByStory.get(story.name)!.saveId}`)"
            >
              回到这一局
            </Button>
            <Button
              v-else
              size="sm"
              :loading="starting(story.name)"
              :disabled="atLimit || !story.playable"
              :title="
                !story.playable
                  ? '这个故事还开不了局——先去编辑页看挡着的是哪几条'
                  : atLimit
                    ? `最多同时开 ${quota.limit} 局`
                    : ''
              "
              @click.stop="startNew(story)"
            >
              <Play class="size-3.5" />
              新开始
            </Button>
            <Button variant="outline" size="sm" @click.stop="progressFor = story">
              <History class="size-3.5" />
              读进度
            </Button>

            <!-- ⚠️ **公共故事只给「复制一份」，不给编辑**：那不是这里判出来的——引擎的写口
                 base 里根本没有公共故事，这两个按钮只是别让人点了才吃 404。 -->
            <Button
              v-if="story.writable"
              variant="outline"
              size="sm"
              title="编辑这个故事的定义"
              @click.stop="router.push(`/galstory/stories/${story.name}/edit`)"
            >
              <Pencil class="size-3.5" />
            </Button>
            <Button
              v-else
              variant="outline"
              size="sm"
              title="复制一份到「我的故事」再改（不影响原来那份）"
              @click.stop="creating = { open: true, from: story }"
            >
              <Copy class="size-3.5" />
            </Button>
            <Button
              v-if="story.writable"
              variant="ghost"
              size="sm"
              class="text-destructive hover:text-destructive"
              :loading="asking(story.name)"
              title="删除这个故事"
              @click.stop="askRemove(story)"
            >
              <Trash2 class="size-3.5" />
            </Button>
          </div>
        </li>
      </ul>
    </template>

    <ProgressDialog
      :story="progressFor"
      @close="progressFor = null"
      @play="(saveId) => router.push(`/galstory/play/${saveId}`)"
    />

    <NewStoryDialog
      :open="creating.open"
      :from="creating.from"
      @close="creating = { open: false, from: null }"
      @created="
        (story) => {
          creating = { open: false, from: null }
          void load()
          router.push(`/galstory/stories/${story.name}/edit`)
        }
      "
    />

    <!-- 删故事。⚠️ **那句「有几个存档基于它」是引擎说的**，界面不自己拼 -->
    <AlertDialog :open="removing !== null" @update:open="(v) => !v && (removing = null)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除《{{ removing?.story.title }}》？</AlertDialogTitle>
          <AlertDialogDescription>{{ removing?.detail }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel @click="removing = null">取消</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            :loading="removingNow"
            @click.prevent="confirmRemove()"
          >
            删除
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
