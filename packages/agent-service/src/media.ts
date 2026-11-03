import { MediaReadError, type MediaAsset, type MediaReader } from '@learning/agent-core/media'
import { AssetStorage } from '@learning/storage'
import { Inject, Injectable } from '@nestjs/common'

/**
 * agent 看图（`view_node_media`，docs/20 §3.10.7）的素材读取：**只读本服务自己的对象存储**，从不请求节点里写的那个地址。
 * 外部链接、`data:`、内网地址在 {@link AssetStorage.readByUrl} 里就是 `foreign`，一个请求都不发（防 SSRF）；不要在这里「退回去 fetch 一下」。
 *
 * 用 `readByUrl` 不用 `read`：复制画布只带地址、不带上传记录（`docs/30` §7），`read` 查归属，复制出来的画布上读不到。
 * 判权不在这里：工具声明的 `flow:read` 由网关统一判，读节点那一下另过画布的 `flow:read`。
 */
@Injectable()
export class AgentMediaReader implements MediaReader {
  constructor(@Inject(AssetStorage) private readonly storage: AssetStorage) {}

  async read(url: string, { maxBytes, signal }: { maxBytes: number; signal?: AbortSignal }): Promise<MediaAsset> {
    let got
    try {
      got = await this.storage.readByUrl(url, { maxBytes, ...(signal ? { signal } : {}) })
    } catch (err) {
      if (signal?.aborted) throw err
      // S3 出错的细节（桶名、错误码）不进模型上下文
      console.warn('[agent] 读取素材失败', err)
      throw new MediaReadError('unavailable', '对象存储读取失败')
    }
    switch (got.status) {
      case 'ok':
        return { data: got.data, contentType: got.contentType }
      case 'unavailable':
        throw new MediaReadError('unavailable', '服务端没有配置对象存储')
      case 'foreign':
        throw new MediaReadError('foreign', '不是本服务对象存储里的素材')
      case 'not_found':
        throw new MediaReadError('not_found', '素材不存在')
      case 'too_large':
        throw new MediaReadError('too_large', `素材超过 ${maxBytes} 字节`)
    }
  }
}
