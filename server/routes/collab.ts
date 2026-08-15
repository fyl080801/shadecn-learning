import { Hono } from 'hono'
import { countConnections, docs } from '../collab/index.ts'

export const collab = new Hono().get('/rooms', (c) =>
  c.json({
    rooms: [...docs.values()].map((doc) => ({
      name: doc.name,
      connections: doc.conns.size,
      awarenessClients: doc.awareness.getStates().size,
    })),
    totalRooms: docs.size,
    totalConnections: countConnections(),
  }),
)
