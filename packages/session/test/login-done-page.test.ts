import { describe, expect, it } from 'vitest'
import { renderLoginDonePage } from '../src/login-done-page.js'

describe('登录窗口的终点站', () => {
  it('postMessage 带前端认的标记，只发给同源', () => {
    const page = renderLoginDonePage()
    expect(page).toContain('source: "app-auth"')
    expect(page).toContain('type: "app-auth:login-done"')
    expect(page).toContain('window.opener.postMessage(message, origin)')
    expect(page).toContain('var origin = window.location.origin')
  })
})
