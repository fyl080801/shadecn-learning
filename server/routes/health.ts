import { Hono } from 'hono'

const startedAt = Date.now()

export const health = new Hono().get('/', (c) =>
  c.json({
    status: 'ok',
    uptime: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  }),
)
