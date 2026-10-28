/**
 * 画布里所有客户端生成的 id 都走这里。
 *
 * 实现挪进了 `@shadecn/shared/id`：服务端的 agent 画布工具也要建节点和连线，
 * 两边的 id 必须是同一种形状（`<前缀>_<时间戳 base36>_<随机段>`，理由见那个文件）。
 * 这里只转出去，前端各处照旧从 `@/lib/id` 取。
 */
export { createId } from "@shadecn/shared/id"
