import { HttpAdapterHost } from '@nestjs/core'
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { describe, expect, it } from 'vitest'
import { FlowBodyParsers } from '../src/flow-body-parsers.js'

const OCTET = { 'content-type': 'application/octet-stream' }

/** 一个 Fastify 实例上，同一个 content-type 被好几个模块要：只能有一个解析器（`POST /doc` 曾因为上传先注册而 415） */
function setup(register: (bodies: FlowBodyParsers) => void) {
  const adapter = new FastifyAdapter()
  const bodies = new FlowBodyParsers({ httpAdapter: adapter } as unknown as HttpAdapterHost)
  register(bodies)
  const fastify = adapter.getInstance()
  const echo = async (request: { body: unknown }) => ({ isBuffer: Buffer.isBuffer(request.body), size: Buffer.isBuffer(request.body) ? request.body.byteLength : null, body: request.body === undefined ? 'untouched' : 'parsed' })
  fastify.post('/doc', echo)
  fastify.post('/assets', echo)
  fastify.post('/other', echo)
  return fastify
}

const DOC = /^\/doc$/
const ASSETS = /^\/assets$/

describe('FlowBodyParsers', () => {
  it.each([
    ['先报 Buffer 的路径', (bodies: FlowBodyParsers) => (bodies.buffered(OCTET['content-type'], DOC, 8), bodies.passThrough(OCTET['content-type'], ASSETS))],
    ['先报原始流的路径', (bodies: FlowBodyParsers) => (bodies.passThrough(OCTET['content-type'], ASSETS), bodies.buffered(OCTET['content-type'], DOC, 8))],
  ])('%s：两条路径各拿各的，别的路径 415', async (_name, register) => {
    const fastify = setup(register)
    const post = (url: string, payload: Buffer) => fastify.inject({ method: 'POST', url, headers: OCTET, payload })

    expect((await post('/doc', Buffer.from('12345'))).json()).toEqual({ isBuffer: true, size: 5, body: 'parsed' })
    expect((await post('/assets', Buffer.from('12345'))).json()).toMatchObject({ isBuffer: false, body: 'untouched' })
    expect((await post('/other', Buffer.from('12345'))).statusCode).toBe(415)
    await fastify.close()
  })

  it('Buffer 路径超过上限 413：响应发得出去，上限按实际读到的字节算；原始流路径不受这个上限影响', async () => {
    const fastify = setup((bodies) => {
      bodies.buffered(OCTET['content-type'], DOC, 8)
      bodies.passThrough(OCTET['content-type'], ASSETS)
    })
    expect((await fastify.inject({ method: 'POST', url: '/doc', headers: OCTET, payload: Buffer.alloc(9) })).statusCode).toBe(413)
    expect((await fastify.inject({ method: 'POST', url: '/doc', headers: OCTET, payload: Buffer.alloc(8) })).statusCode).toBe(200)
    expect((await fastify.inject({ method: 'POST', url: '/assets', headers: OCTET, payload: Buffer.alloc(9) })).statusCode).toBe(200)
    await fastify.close()
  })

  it('同一个 content-type 报多次只注册一个解析器，不同 content-type 各一个', () => {
    const fastify = setup((bodies) => {
      bodies.passThrough('multipart/form-data', ASSETS)
      bodies.passThrough(OCTET['content-type'], ASSETS)
      bodies.buffered(OCTET['content-type'], DOC, 8)
    })
    expect(fastify.hasContentTypeParser('multipart/form-data')).toBe(true)
    expect(fastify.hasContentTypeParser(OCTET['content-type'])).toBe(true)
  })
})
