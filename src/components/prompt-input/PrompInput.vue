<template>
  <div
    ref="rootEl"
    contenteditable="true"
    spellcheck="false"
    @beforeinput="onBeforeInput"
    @keydown="onKeydown"
    @click="onClick"
    @focus="onFocus"
    @blur="onBlur"
    @paste="onPaste"
  ></div>
</template>

<script setup lang="ts">
const onBeforeInput = () => {}

const onKeydown = () => {}

const onClick = () => {}

const onFocus = () => {}

const onBlur = () => {}

const onPaste = () => {}
</script>
