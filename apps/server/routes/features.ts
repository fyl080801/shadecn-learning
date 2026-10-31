import { Hono } from 'hono'
import { loadedFeatures } from '../kernel/registry.ts'

/**
 * `GET /api/features`：这个进程开了哪些能力模块（docs/28 §3.3）。
 * 前端据此隐藏关掉的入口（上传按钮、agent 面板）；它只说「显示什么」，权限仍在各自的路由上。
 * 在登录闸门之内 —— 匿名拿不到部署拓扑。
 */
export const features = new Hono().get('/', (c) => c.json(loadedFeatures()))
