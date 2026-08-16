<script setup lang="ts">
import type { HTMLAttributes } from "vue"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { cn } from "@/lib/utils"
import { presenceInitials, type PresenceUser } from "@/lib/presence"

/**
 * 在场用户的小头像 —— 头像栏、光标标签、节点占用标记三处共用一份。
 *
 * 没有头像图时用用户色打底 + 名字缩写兜底：颜色是那个人的身份标识，
 * 光标、节点黄框旁的标签用的都是同一个色，一眼能对上是谁。
 */
const props = defineProps<{
  user: PresenceUser
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <Avatar :class="cn('size-7', props.class)">
    <AvatarImage v-if="user.avatarUrl" :src="user.avatarUrl" :alt="user.name" />
    <AvatarFallback
      class="text-[10px] font-semibold text-white"
      :style="{ backgroundColor: user.color }"
    >
      {{ presenceInitials(user.name) }}
    </AvatarFallback>
  </Avatar>
</template>
