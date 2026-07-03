// @ts-nocheck
import { ViewHelper as ViewHelperBase } from "three/addons/helpers/ViewHelper.js"

class ViewHelper extends ViewHelperBase {
  constructor(editorCamera, container) {
    super(editorCamera, container)

    this.location.top = 30

    const panel = document.createElement("div")
    panel.id = "viewHelper"
    panel.style.position = "absolute"
    panel.style.right = "0px"
    panel.style.top = "30px"
    panel.style.height = "128px"
    panel.style.width = "128px"

    panel.addEventListener("pointerup", (event) => {
      event.stopPropagation()

      this.handleClick(event)
    })

    panel.addEventListener("pointerdown", function (event) {
      event.stopPropagation()
    })

    container.appendChild(panel)
  }
}

export { ViewHelper }
