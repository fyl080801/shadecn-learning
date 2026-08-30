<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useRoute, useRouter } from "vue-router"
import {
  ArrowLeft,
  CircleCheck,
  FilePlus2,
  Play,
  Save,
  Trash2,
  TriangleAlert
} from "@lucide/vue"
import { toast } from "vue-sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

import BackendNotice from "@/components/galstory/BackendNotice.vue"
import LintList from "@/components/galstory/LintList.vue"
import YamlEditor from "@/components/galstory/YamlEditor.vue"

import { useAsyncAction } from "@/composables/useAsyncAction"
import { GalStoryError, saveApi, storyApi } from "@/lib/galstory"
import type { LintIssue, StoryCheck } from "@/types/galstory"

/**
 * 编辑一个故事的**定义**。
 *
 * ## 为什么是「一份份 yaml」而不是一堆表单字段
 *
 * 故事目录本来就是几份 yaml（`story.yaml` / `flow.yaml` / `characters/*.yaml` /
 * `knowledge/**`），而作者要写的东西**大半是散文**（开场白、角色描述、知识条目正文）。
 * 拿表单去包它，能包住的只有那几个旋钮，正文那一半还是得给一个多行输入框 —— 换来的是
 * 一套要跟着引擎 schema 走的字段映射，而 schema 一改，界面就静默地少一个字段。
 *
 * ⚠️ **这不是「先做个简版」**：字段级的编辑口是另一档接口面积（角色 / 知识条目 / flow 图
 * 各一族），真要做也**必须与这条路共用同一个校验与写回层**，否则就是同一件事两个说法。
 *
 * ## 保存那一刻才是判据
 *
 * 引擎那侧的写回是「**复制到临时目录 → 在那儿改 → 整个装载一遍 → 通过才换入**」，
 * 故这里**不做任何本地校验**：故事的错大半是**跨文件**的（`present` 里的 cid 没有角色卡、
 * `flow.yaml` 的边指向不存在的场景 id），本地那点 yaml 语法检查只会造出「本地绿灯、
 * 保存红灯」的常态，而人会去信那个绿灯。
 *
 * 保存失败分两档，**按状态码分流**：
 * - **403** = 这条路径不可写。`plugins/` 与 `skills/` 里是**会被 exec 的代码**，只能随
 *   「复制一个现成故事」带进来 —— 那是能力边界，说清楚就行；
 * - **422** = 改完之后这个故事跑不起来，blockers 逐条显示，且**原文件一个字节没动**。
 *   最后那半句必须说出来：不说的话人会以为自己刚把故事改坏了。
 *
 * ## `playable` 是现算的
 *
 * 顶上那个「可以开局 / 还开不了」不是一个存储字段（存 `status` 就是存一个会漂的判据），
 * 每次保存后引擎顺手算一遍带回来。故这一页不缓存它、也不自己推。
 */

const route = useRoute()
const router = useRouter()

const storyId = computed(() => String(route.params.storyId ?? ""))

const loading = ref(true)
const error = ref<unknown>(null)

/** 这个故事是不是我的。⚠️ 只影响按钮画不画灰，**不是权限判据**——那在引擎那一侧 */
const writable = ref(false)
/** 标题。⚠️ 加载完之前是空串，模板据此显示骨架而不是把 id 当标题 */
const title = ref("")
const files = ref<string[]>([])
const check = ref<StoryCheck>({ playable: false, blockers: [], issues: [] })

const current = ref("")
/** 服务端上那一份（用来判「改了没有」）。⚠️ 与编辑器里那份分开存，别拿一个变量兼职 */
const saved = ref("")
const draft = ref("")

const dirty = computed(() => draft.value !== saved.value)

/** 保存被拒时那几条。⚠️ 与 `check.blockers` 分开：那是「现在的状态」，这是「这一次没通过」 */
const rejected = ref<{ message: string; blockers: LintIssue[] } | null>(null)

/**
 * ⚠️ **一改就把它清掉**：那句话是**针对某一版文本**说的（「改完之后这个故事跑不起来」），
 * 文本一变它就不再指向编辑器里的东西了。
 *
 * 实跑第一版没清：把改坏的那行改回去之后，红框还挂在下面 —— 于是「现在是好的」与
 * 「刚才那次没过」长得一模一样，人会以为还坏着，而磁盘上那份从头到尾就没变过。
 */
watch(draft, () => {
  rejected.value = null
})

async function load() {
  loading.value = true
  error.value = null
  try {
    const [list, state, summary] = await Promise.all([
      storyApi.files(storyId.value),
      storyApi.check(storyId.value),
      // 选单那条口是唯一能同时答「它是谁的」「叫什么」的地方；作者面详情对公共故事会 404
      storyApi.list("all").then((all) => all.find((s) => s.name === storyId.value) ?? null)
    ])
    files.value = list
    check.value = state
    writable.value = summary?.writable ?? false
    title.value = summary?.title ?? storyId.value
    await open(list[0] ?? "")
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}

/** 切文件。有未保存改动时**先问一句**——切走就没了，而那可能是几十行刚写的东西 */
const pendingSwitch = ref<string | null>(null)

async function open(path: string) {
  if (!path) {
    current.value = ""
    saved.value = draft.value = ""
    return
  }
  const file = await storyApi.readFile(storyId.value, path)
  current.value = path
  saved.value = draft.value = file.text
  rejected.value = null
}

function ask(path: string) {
  if (path === current.value) return
  if (dirty.value) {
    pendingSwitch.value = path
    return
  }
  void open(path)
}

async function discardAndSwitch() {
  const next = pendingSwitch.value
  pendingSwitch.value = null
  if (next) await open(next)
}

void load()
watch(storyId, () => void load())

// ── 保存 ────────────────────────────────────────────────────────────────────

const { run: save, pending: saving } = useAsyncAction(
  async () => {
    if (!current.value || !dirty.value) return
    try {
      check.value = await storyApi.writeFile(storyId.value, current.value, draft.value)
      saved.value = draft.value
      rejected.value = null
      toast.success(`已保存 ${current.value}`)
    } catch (err) {
      if (err instanceof GalStoryError && err.status === 422) {
        // 422 的 payload 里带着那次校验的整个结论 —— 逐条显示，别只给一句「保存失败」
        const inner = (err.payload?.check ?? null) as StoryCheck | null
        rejected.value = { message: err.message, blockers: inner?.blockers ?? [] }
        return
      }
      if (err instanceof GalStoryError && err.status === 403) {
        rejected.value = { message: err.message, blockers: [] }
        return
      }
      throw err
    }
  },
  { errorMessage: "保存失败" }
)

/** Ctrl/Cmd + S。⚠️ 要 `preventDefault`，否则浏览器会弹「保存网页」 */
function onKey(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault()
    if (writable.value) void save()
  }
}
window.addEventListener("keydown", onKey)
onBeforeUnmount(() => window.removeEventListener("keydown", onKey))

// ── 改标题 ──────────────────────────────────────────────────────────────────

const renaming = ref(false)
const nextTitle = ref("")

const { run: rename, pending: renamingNow } = useAsyncAction(
  async () => {
    const name = nextTitle.value.trim()
    if (!name) return
    const story = await storyApi.rename(storyId.value, name)
    title.value = story.title
    renaming.value = false
    toast.success("标题已改")
    // 标题住在 story.yaml 里，引擎是**就地改那一个键**（注释与未知键逐字保住）——
    // 但编辑器里那份是改之前读的，得重新拉一遍，否则一保存就把标题又写回去了
    if (current.value === "story.yaml") await open("story.yaml")
  },
  { errorMessage: "改名失败" }
)

// ── 新建 / 删除文件 ─────────────────────────────────────────────────────────

/**
 * 可新建的位置。**这是一份「方便」的清单，不是判据**——真正的白名单在引擎那一侧
 * （`authoring.editable_path`：目录 + 只认 `.yaml` + 解析后必须仍在故事根内）。
 *
 * ⚠️ 方向是安全的：这里少列一项只是「界面上建不了」，多列一项也会被引擎当场 403 拒掉。
 * **绝不在这里重写那条判据** —— 抄一遍就会漂，而漂了不报错。
 */
const NEW_FILE_KINDS = [
  { dir: "characters", label: "角色卡", hint: "characters/<id>.yaml —— 只写陌生人第一眼看得到的" },
  { dir: "knowledge/characters", label: "私有知识", hint: "只有这个角色知道的（动机、秘密）" },
  { dir: "knowledge/stories", label: "公开人物志", hint: "关于这个人、人人都知道的那部分" }
] as const

const creating = ref(false)
const newKind = ref<string>(NEW_FILE_KINDS[0].dir)
const newName = ref("")

const newPath = computed(() => `${newKind.value}/${newName.value.trim()}.yaml`)

const { run: createFile, pending: creatingNow } = useAsyncAction(
  async () => {
    const id = newName.value.trim()
    if (!id) return
    if (files.value.includes(newPath.value)) {
      toast.error("这个文件已经有了")
      return
    }
    // 建一个**能过校验**的最小内容：空文件在引擎那侧多半装载不起来，而那时的 422
    // 说的是「这个故事跑不起来」——人会以为是自己刚删了什么
    const seed =
      newKind.value === "characters"
        ? `id: ${id}\nname: ${id}\ndescription: ''\npersonality: ''\nmes_example: ''\n`
        : `- uid: ${id}_note\n  text: 还没写。\n`
    // ⚠️ **先把路径取出来**：`newPath` 是从 `newName` 算出来的，而下面要把输入框清空 ——
    // 直接接着用它，拿到的是 `characters/.yaml`（实跑踩过：文件建对了，界面却弹一句
    // 「'characters/.yaml' 不可编辑或不存在」，而人会以为刚才那一步失败了）。
    const path = newPath.value
    check.value = await storyApi.writeFile(storyId.value, path, seed)
    files.value = await storyApi.files(storyId.value)
    creating.value = false
    newName.value = ""
    await open(path)
    toast.success(`已建 ${path}`)
  },
  { errorMessage: "新建失败" }
)

const removingFile = ref<string | null>(null)

const { run: removeFile, pending: removingNow } = useAsyncAction(
  async () => {
    const path = removingFile.value
    if (!path) return
    check.value = await storyApi.deleteFile(storyId.value, path)
    files.value = await storyApi.files(storyId.value)
    removingFile.value = null
    if (current.value === path) await open(files.value[0] ?? "")
    toast.success(`已删 ${path}`)
  },
  {
    onError: (err) => {
      // 删也要先验：删掉唯一在场的角色之后这个故事开不了局 —— 引擎会拒，把话原样给人看
      if (err instanceof GalStoryError && err.status === 422) {
        const inner = (err.payload?.check ?? null) as StoryCheck | null
        rejected.value = { message: err.message, blockers: inner?.blockers ?? [] }
        removingFile.value = null
        return
      }
      toast.error(err instanceof Error ? err.message : "删除失败")
    }
  }
)

// ── 开一局 ──────────────────────────────────────────────────────────────────

const { run: startNew, pending: starting } = useAsyncAction(
  async () => {
    const save = await saveApi.create(storyId.value)
    void router.push(`/galstory/play/${save.id}`)
  },
  { errorMessage: "开局失败" }
)

/** 文件按目录分组显示 —— 一个平坦的长列表看不出「这是角色、那是知识」 */
const grouped = computed(() => {
  const groups = new Map<string, string[]>()
  for (const path of files.value) {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "故事定义"
    if (!groups.has(dir)) groups.set(dir, [])
    groups.get(dir)!.push(path)
  }
  return [...groups.entries()]
})

function baseName(path: string) {
  return path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path
}
</script>

<template>
  <div class="mx-auto flex h-full w-full max-w-7xl flex-col gap-4 p-6">
    <header class="flex flex-wrap items-start gap-3">
      <Button variant="ghost" size="sm" @click="router.push('/galstory/stories')">
        <ArrowLeft class="size-4" />
        故事库
      </Button>
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <h1 v-if="title" class="truncate text-xl font-semibold tracking-tight">{{ title }}</h1>
          <Skeleton v-else class="h-6 w-32" />
          <code class="font-mono text-xs text-muted-foreground">{{ storyId }}</code>
          <!-- ⚠️ **还在加载时一个都不给**：这几格的初值是「只读」「开不了局」，而那不是事实、
               是「还不知道」—— 渲染出来就是当着作者的面说他刚建的故事是别人的、还坏了
               （实跑第一版正是这样，那 3 秒里满屏红字）。判据是**有没有拿到答案**，
               不是「值是什么」；同引擎那一侧「降级的前提是降级后行为仍然正确」那条。 -->
          <template v-if="!loading && !error">
            <Badge v-if="!writable" variant="outline">公共故事 · 只读</Badge>
            <!-- 这一格是**现算**的：每次保存后引擎顺手带回来，界面不缓存也不自己推 -->
            <Badge v-if="check.playable" variant="secondary" class="gap-1">
              <CircleCheck class="size-3" />
              可以开局
            </Badge>
            <Badge v-else variant="destructive" class="gap-1">
              <TriangleAlert class="size-3" />
              还开不了局
            </Badge>
          </template>
        </div>
        <p class="mt-1 text-xs text-muted-foreground">
          改动保存时会把整个故事装载一遍再落盘；没通过的话原文件一个字节都不会动。
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <Button
          v-if="writable && !loading"
          variant="outline"
          size="sm"
          @click="
            () => {
              nextTitle = title
              renaming = true
            }
          "
        >
          改标题
        </Button>
        <Button
          size="sm"
          :loading="starting"
          :disabled="loading || !check.playable"
          @click="startNew()"
        >
          <Play class="size-3.5" />
          开一局
        </Button>
      </div>
    </header>

    <div v-if="loading" class="flex flex-1 gap-4">
      <Skeleton class="h-full w-56" />
      <Skeleton class="h-full flex-1" />
    </div>

    <BackendNotice v-else-if="error" :error="error" @retry="load()" />

    <div v-else class="flex min-h-0 flex-1 gap-4">
      <!-- 左：文件列表 -->
      <aside class="flex w-56 shrink-0 flex-col gap-3 overflow-y-auto">
        <div v-for="[dir, paths] in grouped" :key="dir" class="flex flex-col gap-1">
          <p class="px-2 text-xs font-medium text-muted-foreground">{{ dir }}</p>
          <button
            v-for="path in paths"
            :key="path"
            type="button"
            class="group flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
            :class="path === current ? 'bg-muted font-medium' : ''"
            @click="ask(path)"
          >
            <span class="min-w-0 flex-1 truncate">{{ baseName(path) }}</span>
            <span
              v-if="path === current && dirty"
              class="size-1.5 shrink-0 rounded-full bg-amber-500"
              title="有未保存的改动"
            />
            <Trash2
              v-if="writable && path !== 'story.yaml'"
              class="size-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:opacity-100 hover:text-destructive"
              @click.stop="removingFile = path"
            />
          </button>
        </div>

        <Button v-if="writable" variant="outline" size="sm" @click="creating = true">
          <FilePlus2 class="size-3.5" />
          新建文件
        </Button>
      </aside>

      <!-- 右：编辑器 + 体检 -->
      <section class="flex min-w-0 flex-1 flex-col gap-3">
        <div class="flex items-center gap-2">
          <code class="font-mono text-sm">{{ current || "（这个故事里没有可编辑的文件）" }}</code>
          <span v-if="dirty" class="text-xs text-amber-600">未保存</span>
          <div class="flex-1" />
          <Button
            v-if="writable"
            size="sm"
            :disabled="!dirty || !current"
            :loading="saving"
            @click="save()"
          >
            <Save class="size-3.5" />
            保存
          </Button>
        </div>

        <YamlEditor v-model="draft" :readonly="!writable" class="min-h-0 flex-1" />

        <!-- 这一次为什么没保存成。⚠️ 与下面那块「现在的状态」分开：混在一起的话，
             一条早就存在的 warning 看起来就像是这次改坏的 -->
        <div v-if="rejected" class="flex flex-col gap-2 rounded-lg border border-destructive/50 p-3">
          <p class="text-sm font-medium text-destructive">{{ rejected.message }}</p>
          <LintList v-if="rejected.blockers.length" :issues="rejected.blockers" />
        </div>

        <div v-if="check.blockers.length || check.issues.length" class="flex flex-col gap-2">
          <p class="text-xs font-medium text-muted-foreground">
            <!-- ⚠️ 两件事：blockers 挡着开局，issues 是作者纪律（不挡） -->
            {{ check.blockers.length ? "挡着开局的" : "作者态体检" }}
          </p>
          <LintList :issues="[...check.blockers, ...check.issues]" />
        </div>
      </section>
    </div>

    <!-- 切文件前的未保存提醒 -->
    <AlertDialog
      :open="pendingSwitch !== null"
      @update:open="(v) => !v && (pendingSwitch = null)"
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ current }} 还有未保存的改动</AlertDialogTitle>
          <AlertDialogDescription>切到别的文件会丢掉它们。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>留在这里</AlertDialogCancel>
            <!-- ⚠️ **刻意不是 `AlertDialogAction`**：它内部就是 `DialogClose`，**先关框、再**跑
                 透传下来的 `@click`，而那句关闭不看 `event.defaultPrevented`（`@click.prevent`
                 挡不住）。开关与「删哪一个」共用一个 ref 的话，handler 读到的就是被关闭清成
                 null 的那个 —— **请求一声不响地发不出去**，界面上看着像点了没反应。
                 这个坑本仓库在 `ModelConfig.vue` 踩过一次并写进了测试文件头，这里是第二次。 -->
            <Button variant="destructive" @click="discardAndSwitch()">丢掉并切换</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- 删文件 -->
    <AlertDialog :open="removingFile !== null" @update:open="(v) => !v && (removingFile = null)">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删掉 {{ removingFile }}？</AlertDialogTitle>
          <AlertDialogDescription>
            删之前引擎会把整个故事装载一遍 —— 删掉它之后跑不起来的话，这一步会被拒。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel :disabled="removingNow">取消</AlertDialogCancel>
            <!-- ⚠️ **刻意不是 `AlertDialogAction`**：它内部就是 `DialogClose`，**先关框、再**跑
                 透传下来的 `@click`，而那句关闭不看 `event.defaultPrevented`（`@click.prevent`
                 挡不住）。开关与「删哪一个」共用一个 ref 的话，handler 读到的就是被关闭清成
                 null 的那个 —— **请求一声不响地发不出去**，界面上看着像点了没反应。
                 这个坑本仓库在 `ModelConfig.vue` 踩过一次并写进了测试文件头，这里是第二次。 -->
            <Button variant="destructive" :loading="removingNow" @click="removeFile()">
              删除
            </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- 改标题 -->
    <Dialog :open="renaming" @update:open="(v) => (renaming = v)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>改标题</DialogTitle>
          <DialogDescription>
            只改 story.yaml 里的 title 那一个键，注释与其它内容一个字都不动。
          </DialogDescription>
        </DialogHeader>
        <Input v-model="nextTitle" autofocus @keydown.enter.prevent="rename()" />
        <DialogFooter>
          <Button variant="outline" @click="renaming = false">取消</Button>
          <Button :loading="renamingNow" @click="rename()">保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 新建文件 -->
    <Dialog :open="creating" @update:open="(v) => (creating = v)">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建文件</DialogTitle>
          <DialogDescription>
            故事目录里只有 yaml 可以编辑 —— 插件与 skill 是会被执行的代码，只能随「复制一个
            现成故事」带进来。
          </DialogDescription>
        </DialogHeader>

        <div class="flex flex-col gap-3">
          <div class="flex flex-col gap-2">
            <Label>放在哪</Label>
            <Select v-model="newKind">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="kind in NEW_FILE_KINDS" :key="kind.dir" :value="kind.dir">
                  {{ kind.label }}
                </SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">
              {{ NEW_FILE_KINDS.find((k) => k.dir === newKind)?.hint }}
            </p>
          </div>
          <div class="flex flex-col gap-2">
            <Label for="new-file-id">id</Label>
            <Input id="new-file-id" v-model="newName" placeholder="例如 lin" />
            <code class="font-mono text-xs text-muted-foreground">{{ newPath }}</code>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" @click="creating = false">取消</Button>
          <Button :loading="creatingNow" :disabled="!newName.trim()" @click="createFile()">
            建立
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
