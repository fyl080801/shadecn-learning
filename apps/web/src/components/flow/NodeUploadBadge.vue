<script setup lang="ts">
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
</script>

<template>
  <!-- 「上传中」角标（图片 / 视频的 badge 区；只在本地有上传在跑时挂上，见 `node-upload.ts`） -->
  <Badge
    variant="secondary"
    class="bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-600 dark:text-sky-400"
    data-testid="node-status-uploading"
  >
    <Spinner class="size-3" />
    上传中
  </Badge>
</template>
