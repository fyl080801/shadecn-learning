<!--
  不带菜单的模板页 —— 页面独占整屏（画布编辑器）。
  注意这不是登录态的例外：挂在这里的路由同样是登录后才进得来。
-->
<template>
  <div class="h-screen overflow-hidden bg-background">
    <RouterView />
  </div>
</template>
