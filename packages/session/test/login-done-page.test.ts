import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOGIN_DONE_PATH, renderLoginDonePage } from '../src/login-done-page.js'

/** 前端靠这几个值开窗口、认消息。本包不依赖前端的共享包，所以读它的源码文件比对：对方改了值，这里失败 */
const frontendContract = fs.readFileSync(path.resolve(import.meta.dirname, '../../shared/src/auth.ts'), 'utf8')
const declared = (name: string) => {
  const prefix = `export const ${name} = '`
  const start = frontendContract.indexOf(prefix)
  if (start === -1) throw new Error(`packages/shared/src/auth.ts 里没有 ${name}`)
  return frontendContract.slice(start + prefix.length, frontendContract.indexOf("'", start + prefix.length))
}

describe('登录窗口的终点站', () => {
  it('路径和前端声明的一致', () => {
    expect(LOGIN_DONE_PATH).toBe(declared('LOGIN_DONE_PATH'))
  })

  it('postMessage 的 source / type 和前端声明的一致，只发给同源', () => {
    const page = renderLoginDonePage()
    expect(page).toContain(`source: ${JSON.stringify(declared('LOGIN_DONE_SOURCE'))}`)
    expect(page).toContain(`type: ${JSON.stringify(declared('LOGIN_DONE_MESSAGE'))}`)
    expect(page).toContain('window.opener.postMessage(message, origin)')
    expect(page).toContain('var origin = window.location.origin')
  })
})
