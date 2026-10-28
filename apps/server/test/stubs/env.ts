/**
 * 测试环境下顶替 server/env.ts。
 *
 * 真身会 process.loadEnvFile() 读仓库根目录的 .env —— 那是开发者自己的
 * Keycloak 地址和密钥，测试跟着它跑就会「在我机器上是绿的」。
 * 这里什么都不做，环境变量一律由 vitest.config.ts 的 test.env 提供。
 */
export {}
