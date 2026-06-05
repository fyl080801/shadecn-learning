<script setup lang="ts">
/**
 * MentionElement — the default Slate-style renderer for a mention node.
 *
 * Mirrors Slate's React example:
 *   <span
 *     {...attributes}              // data-slate-node, data-slate-inline,
 *                                  // data-slate-void
 *     contenteditable={false}
 *   >
 *     <span data-slate-leaf>
 *       @{character}{children}
 *     </span>
 *   </span>
 *
 * Consumers can override the element rendering via the `element` slot on
 * <MentionEditor>; this file just provides the default look.
 */
import { computed } from 'vue'
import type { Mention } from './types'

const props = defineProps<{
  attributes: Record<string, unknown>
  element: Mention
}>()

const style = computed(() => {
  const selected = !!props.attributes['data-slate-selected']
  return {
    padding: '3px 3px 2px',
    margin: '0 1px',
    verticalAlign: 'baseline',
    display: 'inline-block',
    borderRadius: '4px',
    backgroundColor: '#eee',
    fontSize: '0.9em',
    boxShadow: selected ? '0 0 0 2px #B4D5FF' : 'none'
  } as Record<string, string>
})
</script>

<template>
  <span
    v-bind="attributes"
    contenteditable="false"
    :style="style"
    :data-cy="`mention-${element.character.replace(/\s+/g, '-')}`"
  >
    <!-- The inner span is purely visual; selection never lands here. -->
    <span>@{{ element.character }}</span>
  </span>
</template>
