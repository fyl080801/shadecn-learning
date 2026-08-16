-- Yjs 成为画布内容的唯一事实源。sqlite 那份的等价物，见它的注释。
--
-- FlowOperation 的旧行按丢弃处理：存的是已废弃的 FlowOp JSON，转不成 Yjs update。
-- 画布内容不受影响 —— 内容在 Flow.graph 里，服务端第一次打开时会迁进 ydoc。

-- AlterTable
ALTER TABLE "Flow" ADD COLUMN "ydoc" BYTEA;

-- 先清空再改结构：update 是 NOT NULL 且没有合理的默认值
DELETE FROM "FlowOperation";

-- DropIndex
DROP INDEX IF EXISTS "FlowOperation_flowId_txId_key";

-- AlterTable
ALTER TABLE "FlowOperation"
    DROP COLUMN "txId",
    DROP COLUMN "kind",
    DROP COLUMN "label",
    DROP COLUMN "ops",
    DROP COLUMN "clientTs",
    ADD COLUMN "update" BYTEA NOT NULL;
