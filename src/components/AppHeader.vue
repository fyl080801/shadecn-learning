<script setup lang="ts">
import { RouterLink } from "vue-router"
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList
} from "@/components/ui/navigation-menu"
import { Badge } from "@/components/ui/badge"

interface NavItem {
  label: string
  to: string
}

const navItems: NavItem[] = [
  { label: "Home", to: "/" },
  { label: "About", to: "/about" },
  { label: "Example", to: "/example" },
  { label: "3D Cube", to: "/3d-cube" },
  { label: "贪吃蛇", to: "/snake" },
  { label: "2048", to: "/2048" },
  { label: "canvas3d", to: "/canvas3d" },
  { label: "lightscene", to: "/lightscene" }
]
</script>

<template>
  <header
    class="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60"
  >
    <div class="container mx-auto flex h-14 items-center px-4">
      <RouterLink to="/" class="mr-6 flex items-center space-x-2">
        <img src="@/assets/vue.svg" class="h-6 w-6" alt="Vue logo" />
        <span class="font-bold">My App</span>
      </RouterLink>
      <NavigationMenu>
        <NavigationMenuList>
          <NavigationMenuItem v-for="item in navItems" :key="item.to">
            <NavigationMenuLink as-child>
              <RouterLink
                :to="item.to"
                class="group inline-flex h-9 w-max items-center justify-center rounded-md bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none disabled:pointer-events-none disabled:opacity-50 data-[active]:bg-accent/50 data-[state=open]:bg-accent/50"
                active-class="bg-accent"
              >
                {{ item.label }}
              </RouterLink>
            </NavigationMenuLink>
          </NavigationMenuItem>
        </NavigationMenuList>
      </NavigationMenu>
      <div class="ml-auto flex items-center space-x-4">
        <Badge variant="secondary">v1.0.0</Badge>
      </div>
    </div>
  </header>
</template>
