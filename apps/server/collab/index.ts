/**
 * 协同层的出入口。
 *
 * 服务端是 [Hocuspocus](https://tiptap.dev/docs/hocuspocus)（MIT），挂在应用自己的
 * HTTP server 上 —— 见 `hocuspocus.ts`。以前这里是一份 y-websocket `bin/utils.js`
 * 的移植（282 行），协议、心跳、房间生命周期全得自己维护；换掉之后那些都是上游的事，
 * 我们只留「谁能进」「存哪儿」「谁改的」这三件业务钩子。
 */
export {
  attachCollabServer,
  collabStats,
  COLLAB_PATH,
  flushAllRoomsToDatabase,
  flushRoomToDatabase,
  revokeCollabAccess,
  type CollabContext,
} from './hocuspocus.ts'
export {
  flowIdOf,
  flushCollabWrites,
  forgetFlow,
  loadFlowState,
  roomOf,
  storeFlowState,
} from './persistence.ts'
export { applyGraphToDoc, readGraphFromDoc } from './flow-doc.ts'
