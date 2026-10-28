const LoaderUtils = {
  createFilesMap: function (files: File[]) {
    const map: Record<string, File> = {}

    for (let i = 0; i < files.length; i++) {
      const file = files[i]!
      map[file.name] = file
    }

    return map
  },

  getFilesFromItemList: function (
    items: DataTransferItemList,
    onDone: (files: any[], filesMap: Record<string, any>) => void
  ) {
    // 待修复：当加载的文件不在根目录时，setURLModifier() 会出错

    let itemsCount = 0
    let itemsTotal = 0

    const files: any[] = []
    const filesMap: Record<string, any> = {}

    function onEntryHandled() {
      itemsCount++

      if (itemsCount === itemsTotal) {
        onDone(files, filesMap)
      }
    }

    function handleEntry(entry: any) {
      if (entry.isDirectory) {
        const reader = entry.createReader()
        reader.readEntries(function (entries: any[]) {
          for (let i = 0; i < entries.length; i++) {
            handleEntry(entries[i])
          }

          onEntryHandled()
        })
      } else if (entry.isFile) {
        entry.file(function (file: any) {
          files.push(file)

          filesMap[entry.fullPath.slice(1)] = file
          onEntryHandled()
        })
      }

      itemsTotal++
    }

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!

      if (item.kind === "file") {
        handleEntry(item.webkitGetAsEntry())
      }
    }
  }
}

export { LoaderUtils }
