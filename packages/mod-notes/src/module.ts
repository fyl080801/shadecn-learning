import { defineModule } from '@shadecn/server-kit/kernel'
import { notes } from './routes.ts'

/**
 * 笔记示例模块：内存里的一份笔记（进程重启即清空），演示一个最小的模块 —— 一条入口声明、`setup` 里挂上。
 * 不落库、不跨副本：只随 web 角色加载。
 */
export default defineModule({
  name: 'notes',
  roles: ['web'],
  routes: [{ path: '/api/notes', role: 'web', access: 'user' }],
  setup(ctx) {
    ctx.http.route('/api/notes', notes)
  },
})
