// @ts-nocheck
import { UISpan } from "./libs/ui"

import { SidebarProjectApp } from "./Sidebar.Project.App"
import { SidebarProjectRenderer } from "./Sidebar.Project.Renderer"
import { SidebarProjectResources } from "./Sidebar.Project.Resources"

function SidebarProject(editor) {
  const container = new UISpan()

  container.add(new SidebarProjectRenderer(editor))

  container.add(new SidebarProjectApp(editor))

  container.add(new SidebarProjectResources(editor))

  return container
}

export { SidebarProject }
