/**
 * local-start.mjs 注册的解析钩子（跑在 Node 的 hooks 线程里）。
 *
 * 只兜「找不到的裸包名」这一种情况：相对路径、`node:` 内建模块、找到了的包都原样放行，
 * 所以对产物本身的解析没有任何影响。
 */
const serverPackage = new URL('../package.json', import.meta.url).href

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context)
  } catch (err) {
    const bare = !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.includes(':')
    if (!bare || err?.code !== 'ERR_MODULE_NOT_FOUND') throw err
    return nextResolve(specifier, { ...context, parentURL: serverPackage })
  }
}
