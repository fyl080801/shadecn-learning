-- Yjs 成为画布内容的唯一事实源。
--
-- Flow.ydoc 存 Y.encodeStateAsUpdate 的二进制；graph JSON 降级为服务端派生的只读投影。
-- 老画布的 ydoc 为 NULL，服务端在第一次打开时从 graph JSON 现场构建（见 collab/persistence.ts），
-- 所以这里不需要数据迁移。
--
-- FlowOperation 改存 Yjs 增量更新。**旧行按丢弃处理**：它们存的是已废弃的 FlowOp JSON，
-- 描述的操作语义在新模型里不存在，转不成 Yjs update，留着也回放不出来。
-- 画布内容本身不受影响 —— 内容在 Flow.graph 里，会迁进 ydoc。

-- AlterTable
ALTER TABLE "Flow" ADD COLUMN "ydoc" BLOB;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_FlowOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "flowId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "update" BLOB NOT NULL,
    "actorId" TEXT,
    "serverTs" BIGINT NOT NULL,
    CONSTRAINT "FlowOperation_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
DROP TABLE "FlowOperation";
ALTER TABLE "new_FlowOperation" RENAME TO "FlowOperation";
CREATE INDEX "FlowOperation_flowId_seq_idx" ON "FlowOperation"("flowId", "seq");
CREATE UNIQUE INDEX "FlowOperation_flowId_seq_key" ON "FlowOperation"("flowId", "seq");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
