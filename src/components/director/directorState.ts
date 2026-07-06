import { ref } from "vue"

// Shared UI state for the director console. A single console is shown per
// page, so a module-level singleton is simpler than threading these through
// props/provide across the tabs, toolbar and properties panels.
export const showCharacterLabels = ref(true)
export const activeView = ref<"director" | "camera">("director")
export const activeCameraUuid = ref<string | null>(null)
