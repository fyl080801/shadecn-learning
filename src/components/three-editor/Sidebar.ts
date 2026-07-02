// @ts-nocheck
import { UITabbedPanel, UISpan } from "./libs/ui"

import { SidebarScene } from "./Sidebar.Scene"
import { SidebarProperties } from "./Sidebar.Properties"
import { SidebarProject } from "./Sidebar.Project"
import { SidebarSettings } from "./Sidebar.Settings"

function Sidebar(editor) {
  const strings = editor.strings

  const container = new UITabbedPanel()
  container.setId("sidebar")

  const sidebarProperties = new SidebarProperties(editor)

  const scene = new UISpan().add(new SidebarScene(editor), sidebarProperties)
  const project = new SidebarProject(editor)
  const settings = new SidebarSettings(editor)

  container.addTab("scene", strings.getKey("sidebar/scene"), scene)
  container.addTab("project", strings.getKey("sidebar/project"), project)
  container.addTab("settings", strings.getKey("sidebar/settings"), settings)
  container.select("scene")

  const sidebarPropertiesResizeObserver = new ResizeObserver(function () {
    sidebarProperties.tabsDiv.setWidth(getComputedStyle(container.dom).width)
  })

  sidebarPropertiesResizeObserver.observe(container.tabsDiv.dom)

  return container
}

export { Sidebar }
