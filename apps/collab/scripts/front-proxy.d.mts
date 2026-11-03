import type { Server } from 'node:http'

export function isCollabPath(pathname: string): boolean

export function createFrontProxy(options: { platformPort: number; replicaPorts: number[] }): {
  server: Server
  removeReplica(port: number): number
  close(): Promise<void>
}
