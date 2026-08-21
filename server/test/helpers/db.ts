import { prisma } from '../../db.ts'
import type { User } from '../../generated/prisma/client.ts'

export { prisma }

/** 每个用例前清库。都有外键，先删子表 */
export async function resetDb() {
  await prisma.flow.deleteMany()
  await prisma.projectInvite.deleteMany()
  await prisma.projectMember.deleteMany()
  await prisma.project.deleteMany()
  await prisma.session.deleteMany()
  await prisma.authRequest.deleteMany()
  await prisma.user.deleteMany()
}

export interface FakeUserInput {
  subject?: string
  issuer?: string
  username?: string | null
  email?: string | null
  name?: string | null
  roles?: string[]
}

/** 直接往库里塞一个用户，绕开 OIDC 流程 */
export function createUser(input: FakeUserInput = {}): Promise<User> {
  return prisma.user.create({
    data: {
      issuer: input.issuer ?? 'https://keycloak.test/realms/test',
      subject: input.subject ?? 'user-1',
      username: input.username ?? 'alice',
      email: input.email ?? 'alice@example.com',
      name: input.name ?? 'Alice',
      roles: JSON.stringify(input.roles ?? []),
    },
  })
}
