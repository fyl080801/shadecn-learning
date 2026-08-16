import { Hono } from 'hono'
import { collabStats } from '../collab/index.ts'

/** 协同的监控端点：现在有哪些房间、各自几条连接 */
export const collab = new Hono().get('/rooms', (c) => c.json(collabStats()))
