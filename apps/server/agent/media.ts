import { MediaReadError, type MediaReader } from '@shadecn/agent/media'
import { s3Config } from '../config.ts'
import { assetStorage } from '../storage/index.ts'
import { assetKeyOfUrl } from '../storage/keys.ts'

/**
 * agent 看图（`view_node_media`，docs/20 §3.10.7）在本服务里的素材读取：**只读本服务自己的对象存储**。
 *
 * 节点里存的是 S3 原始地址（`storage.objectUrl(key)`）。这里先把地址反解成对象键（`assetKeyOfUrl`：
 * 必须是本桶、`S3_KEY_PREFIX` 的素材目录下、我们拼出来的形状），再按键签名读 —— **从不请求节点里写的那个地址**，
 * 外部链接、`data:`、内网地址在反解那一步就是 `foreign`，一个请求都不发（防 SSRF）。
 * 判权不在这里：工具声明的 `flow:read` 由网关统一判（`session.ts`），读节点那一下另过画布的 `flow:read`。
 *
 * 存储按需取（`assetStorage()`），没配就是 `unavailable`；测试用 `replaceAssetStorage()` 换假的。
 */
export const agentMediaReader: MediaReader = {
  async read(url, { maxBytes, signal }) {
    const storage = assetStorage()
    if (!storage) throw new MediaReadError('unavailable', '服务端没有配置对象存储')
    const key = assetKeyOfUrl(url, storage.objectUrl(''), s3Config.keyPrefix)
    if (!key) throw new MediaReadError('foreign', '不是本服务对象存储里的素材')
    let got
    try {
      got = await storage.getObject(key, { maxBytes, ...(signal ? { signal } : {}) })
    } catch (err) {
      if (signal?.aborted) throw err
      console.warn(`[agent] 读取素材失败 key=${key}`, err)
      throw new MediaReadError('unavailable', '对象存储读取失败')
    }
    if (got.status === 'not_found') throw new MediaReadError('not_found', '素材不存在')
    if (got.status === 'too_large') throw new MediaReadError('too_large', `素材超过 ${maxBytes} 字节`)
    return { data: got.body, contentType: got.contentType }
  },
}
