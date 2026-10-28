import { app } from '../../app.ts'
import { signIn } from './session.ts'

/** 一个「已登录的浏览器」：带着 cookie 直接发请求 */
export interface Actor {
  userId: string
  cookie: string
  request: (path: string, init?: RequestInit) => Promise<Response>
  json: (path: string, method: string, body?: unknown) => Promise<Response>
}

let seq = 0

/** 造一个登录用户；多次调用会拿到不同的人（subject 唯一） */
export async function actor(name = 'alice'): Promise<Actor> {
  seq += 1
  const { user, cookie } = await signIn({
    subject: `user-${seq}`,
    username: name,
    name,
    email: `${name}${seq}@example.com`,
  })

  const request = async (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: { ...init.headers, cookie } })

  return {
    userId: user.id,
    cookie,
    request,
    json: (path, method, body) =>
      request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  }
}

/** 建项目，返回 id */
export async function createProject(owner: Actor, name = '测试项目'): Promise<string> {
  const res = await owner.json('/api/projects', 'POST', { name })
  const body = (await res.json()) as { id: string }
  return body.id
}

/** 建画布，返回 id */
export async function createFlow(
  member: Actor,
  projectId: string,
  name = '测试画布',
): Promise<string> {
  const res = await member.json(`/api/projects/${projectId}/flows`, 'POST', { name })
  const body = (await res.json()) as { id: string }
  return body.id
}

/** 让 invitee 通过项目的分享链接加入 */
export async function joinViaInvite(admin: Actor, projectId: string, invitee: Actor) {
  const token = await shareToken(admin, projectId)
  await invitee.json(`/api/invites/${token}/accept`, 'POST')
  return token
}

/** 取项目的分享链接 token（没有就由服务端当场建一条） */
export async function shareToken(admin: Actor, projectId: string) {
  const res = await admin.request(`/api/projects/${projectId}/invite`)
  const invite = (await res.json()) as { token: string }
  return invite.token
}
