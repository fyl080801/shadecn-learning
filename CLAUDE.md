# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Vue 3 learning/experimentation sandbox that combines shadcn-vue UI components, Three.js 3D scenes, and canvas-based mini-games. It serves as a playground for exploring different Vue and web technologies within a single app.

## Commands

- `pnpm dev` — Start dev server (Vite)
- `pnpm build` — Type-check with `vue-tsc` then build with Vite
- `pnpm preview` — Preview production build

No test runner or linter is configured.

## Architecture

**Stack:** Vue 3 + TypeScript + Vite + Tailwind CSS v4 + shadcn-vue (new-york style)

**Path alias:** `@/` maps to `src/` (configured in both `vite.config.ts` and `tsconfig.app.json`)

**Routing:** `src/router/index.ts` — flat route structure with vue-router 5 (history mode). Each view is a standalone demo page.

**Layout:** `App.vue` renders `AppHeader` (navigation bar using shadcn NavigationMenu) + `<RouterView>`. The app fills the viewport height (`h-screen`).

**UI Components (shadcn-vue):** Located in `src/components/ui/`. Added via the `shadcn-vue` CLI (configured in `components.json`). Current set: badge, button, card, navigation-menu, separator. Icon library is `lucide-vue-next`. The `cn()` utility in `src/lib/utils.ts` merges Tailwind classes via `clsx` + `tailwind-merge`.

**Styling:** Tailwind CSS v4 loaded via `@tailwindcss/vite` plugin. CSS variables for theming (light/dark) are defined in `src/style.css` using oklch colors. Uses `tw-animate-css` for animations.

**Views (demo pages):**
- `Home.vue` — Landing page with counter demo using shadcn components
- `About.vue` — (not yet implemented)
- `Example.vue` — Interactive draggable point with connecting lines
- `Emu3DView.vue` — CSS-based 3D cube (uses `Cube3D.vue` component)
- `Demo3.vue` — Canvas-based brick-breaker game
- `SnakeGame.vue` — Canvas-based snake game
- `Game2048.vue` — 2048 puzzle game (scoped CSS, no shadcn components)
- `Canvas3D.vue` / `LightScene.vue` — Three.js scenes (scaffolds, not yet implemented)

**3D:** Three.js is a dependency with types (`@types/three`). The `Cube3D.vue` component is pure CSS 3D transforms (not Three.js). The Three.js views (`Canvas3D`, `LightScene`) are placeholders.

**Key dependencies:** `reka-ui` (headless UI primitives behind shadcn-vue), `@vueuse/core`, `class-variance-authority`, `vue-router` 5.

## Conventions

- TypeScript strict mode with `noUnusedLocals`, `noUnusedParameters`, `erasableSyntaxOnly`
- All Vue components use `<script setup lang="ts">`
- Package manager: pnpm