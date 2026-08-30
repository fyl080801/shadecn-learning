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

import { GalStoryError, emphasize, runApi, saveApi, storyApi, structureLabel } from "@/lib/galstory"
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
 * ## 版式：3:4 竖版封面的卡片栅格
 *
 * 手机一列、往上逐档加列（`GRID_CLASS`，判据写在它上面）。⚠️ **改版前是「一行一条」的横条**，
 * 而那条横条在窄屏下会**静默地叠起来**：中间是 `min-w-0 flex-1` 的标题块、右边是 `shrink-0` 的
 * 四个按钮，宽度不够时按钮一个像素都不让，直接压在标题与 id 上（id 被切成三截），最右那颗删除
 * 还溢出卡片边界被裁掉一半。**它不会报错、桌面上也看不出来** —— 这类版式错只能靠真的把窗口
 * 拖窄看一眼。故这一版的四个动作**分两处放**：主动作（新开始 / 读进度）在卡片底边等分一行，
 * 次要动作（编辑或复制 / 删除）压在封面右上角，两边都不必跟对方抢宽度。
 *
 * ## 每张卡两个主动作
 *
 * **新开始** = 建一个新存档再进对局；**读进度** = 弹出这个故事下**我**玩过的实例。
 * 「我的」这件事在服务端那一层就成立了（每条转发带 `X-Gal-Owner: <登录用户 id>`，引擎按属主
 * 分存档目录），故这一页没有任何按用户过滤的代码 —— 在前端再滤一次既是两处声明，也挡不住谁。
 *
 * ⚠️ 整张卡是可点的（进详情页），故卡内每个按钮都要 `@click.stop`，否则点「新开始」会顺带跳走。
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

/**
 * 故事卡的栅格。**手机一列，往上逐档加列**。
 *
 * ⚠️ **用 grid 不用 `flex-wrap`**：卡片是 3:4 竖版封面 + 定高的按钮行，同一行里必须**等宽等高**
 * ——`flex-wrap` 给不了这个（每张各按内容定宽，要等宽就得手算 `basis` 与 `gap` 的那笔账，
 * 而最后一行还会被拉伸或留下参差的尾巴）。grid 的列宽是容器算的，加一档断点只改这一个字符串。
 *
 * ⚠️ **列数的判据是「卡片别窄过 ~200px」**，不是「屏幕大就多塞几张」：3:4 的封面再窄下去
 * 标题就只剩两三个字，而底下那行「新开始 + 读进度」在 200px 以下会开始互相挤。按侧栏展开
 * （256px）算，最窄的一档是 xl 四列 ≈ 220px、lg 三列 ≈ 229px，都刚好在线上。
 *
 * ⚠️ **它是个常量而不是写在模板里**：骨架屏必须与真列表**逐字**同一串类，否则加载完那一瞬间
 * 版式会跳一次；抄两份就是同一个判据两处声明，而漂了不报错、只是骨架屏对不上列表。
 */
const GRID_CLASS = "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"

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
  <div class="mx-auto flex h-full w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
    <!-- ⚠️ 窄屏**先竖过来**再谈对齐：说明文字与两个按钮抢同一行时，让位的一定是文字
         （按钮 `whitespace-nowrap`），于是一句话被压成六行窄条而按钮只挪了几个像素。 -->
    <header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div class="min-w-0">
        <h1 class="text-2xl font-semibold tracking-tight">故事库</h1>
        <p class="text-sm text-muted-foreground">
          作者态的故事模板。开一局会把模板整份复制进存档，此后改模板不影响进行中的那一局。
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2 sm:shrink-0 sm:gap-3">
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

    <!-- 骨架屏与真列表**共用同一串栅格类**：换成几条通栏横条的话，加载完那一瞬间整版会跳一次 -->
    <div v-if="loading" :class="GRID_CLASS">
      <div v-for="i in 8" :key="i" class="flex flex-col gap-2">
        <Skeleton class="aspect-[3/4] w-full rounded-lg" />
        <Skeleton class="h-4 w-2/3" />
        <Skeleton class="h-3 w-1/2" />
      </div>
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
        <!-- ⚠️ `flex-1` 的 basis 是 0，光靠它这个框会被 Tabs 挤到只剩几十像素还赖在同一行上
             （占位文字被切成「搜索故事名称」）。给一条最小宽度，摆不下就整个换行。 -->
        <div class="relative min-w-48 max-w-sm flex-1">
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
      <ul v-else :class="GRID_CLASS">
        <li
          v-for="story in shown"
          :key="story.name"
          class="flex cursor-pointer flex-col overflow-hidden rounded-lg border transition-colors hover:bg-muted/50"
          @click="router.push(`/galstory/stories/${story.name}`)"
        >
          <!-- 封面。作者没给地址就用占位 —— **占位在这一层生成**，引擎只如实说「给没给」。
               ⚠️ 比例写死 3:4（竖版），不随图走：图是外链、尺寸各式各样，让它自己撑高度的话
               同一行的卡片会各长各的，栅格立刻变成参差不齐的瀑布流。`object-cover` 裁掉多余的。 -->
          <div class="relative aspect-[3/4] w-full overflow-hidden bg-muted">
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
              <ImageIcon class="size-10 text-muted-foreground/40" />
            </div>

            <!-- ⚠️ **次要动作压在封面右上角，不跟主动作抢那一行**：卡片最窄的一档只有约 220px
                 （xl 四列），「新开始 + 读进度 + 编辑 + 删除」四个并排要 250px 以上——挤不下时
                 `whitespace-nowrap` 的按钮不会让位，只会把文字盖掉，那正是改版前那一版的病根。
                 也**不藏在 hover 里**：手机上没有 hover，藏起来等于在手机上删掉这两个功能。 -->
            <div class="absolute right-2 top-2 flex gap-1">
              <!-- ⚠️ **公共故事只给「复制一份」，不给编辑**：那不是这里判出来的——引擎的写口
                   base 里根本没有公共故事，这两个按钮只是别让人点了才吃 404。 -->
              <Button
                v-if="story.writable"
                variant="secondary"
                size="icon-sm"
                class="bg-background/85 backdrop-blur-sm hover:bg-background"
                title="编辑这个故事的定义"
                @click.stop="router.push(`/galstory/stories/${story.name}/edit`)"
              >
                <Pencil class="size-3.5" />
              </Button>
              <Button
                v-else
                variant="secondary"
                size="icon-sm"
                class="bg-background/85 backdrop-blur-sm hover:bg-background"
                title="复制一份到「我的故事」再改（不影响原来那份）"
                @click.stop="creating = { open: true, from: story }"
              >
                <Copy class="size-3.5" />
              </Button>
              <Button
                v-if="story.writable"
                variant="secondary"
                size="icon-sm"
                class="bg-background/85 text-destructive backdrop-blur-sm hover:bg-background hover:text-destructive"
                :loading="asking(story.name)"
                title="删除这个故事"
                @click.stop="askRemove(story)"
              >
                <Trash2 class="size-3.5" />
              </Button>
            </div>

            <!-- 状态徽章压在封面左下：扫一排封面时要一眼看见的就是这两条 -->
            <div class="absolute inset-x-2 bottom-2 flex flex-wrap gap-1">
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
                class="cursor-pointer gap-1"
                :title="`已经跑了 ${Math.round(runningByStory.get(story.name)!.elapsed)} 秒，点击回到这一局`"
                @click.stop="router.push(`/galstory/play/${runningByStory.get(story.name)!.saveId}`)"
              >
                <Loader2 class="size-3 animate-spin" />
                进行中
              </Badge>
            </div>
          </div>

          <!-- `flex-1` 让文字块吃掉高度差：同一行里标题占一行与占两行的卡片，按钮仍对齐在底边 -->
          <div class="flex flex-1 flex-col gap-1 p-3">
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate font-medium" :title="story.title">
                {{ story.title }}
              </span>
              <Badge v-if="story.scope === 'mine'" variant="outline" class="shrink-0">我的</Badge>
            </div>
            <!-- id 是「play --story <name>」里的那个名字，长到放不下就截断，但整串留在 title 上 -->
            <code class="truncate font-mono text-xs text-muted-foreground" :title="story.name">
              {{ story.name }}
            </code>
            <p class="mt-auto pt-1 text-xs text-muted-foreground">
              {{ structureLabel(null, story.scenes) }} · {{ story.characters }} 个角色 ·
              {{ story.saves }} 份存档
            </p>
          </div>

          <!-- ⚠️ 整张卡是可点的（进详情），故卡里每个按钮都要 @click.stop -->
          <div class="flex gap-2 p-3 pt-0">
            <Button
              v-if="runningByStory.get(story.name)"
              size="sm"
              class="min-w-0 flex-1"
              @click.stop="router.push(`/galstory/play/${runningByStory.get(story.name)!.saveId}`)"
            >
              回到这一局
            </Button>
            <Button
              v-else
              size="sm"
              class="min-w-0 flex-1"
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
            <Button
              variant="outline"
              size="sm"
              class="min-w-0 flex-1"
              @click.stop="progressFor = story"
            >
              <History class="size-3.5" />
              读进度
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
          <AlertDialogDescription>
            <!-- 引擎的文案用 `**…**` 标重点，原样渲染就是一串星号（判据在 `emphasize` 一处） -->
            <template v-for="(seg, i) in emphasize(removing?.detail ?? '')" :key="i">
              <strong v-if="seg.strong" class="font-medium text-foreground">{{ seg.text }}</strong>
              <template v-else>{{ seg.text }}</template>
            </template>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="removingNow">取消</AlertDialogCancel>
            <!-- ⚠️ **刻意不是 `AlertDialogAction`**：它内部就是 `DialogClose`，**先关框、再**跑
                 透传下来的 `@click`，而那句关闭不看 `event.defaultPrevented`（`@click.prevent`
                 挡不住）。开关与「删哪一个」共用一个 ref 的话，handler 读到的就是被关闭清成
                 null 的那个 —— **请求一声不响地发不出去**，界面上看着像点了没反应。
                 这个坑本仓库在 `ModelConfig.vue` 踩过一次并写进了测试文件头，这里是第二次。 -->
            <Button variant="destructive" :loading="removingNow" @click="confirmRemove()">
              删除
            </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
