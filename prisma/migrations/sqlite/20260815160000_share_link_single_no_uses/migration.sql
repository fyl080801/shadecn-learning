-- 分享链接改为「一个项目一条」：去掉 maxUses / usedCount / revokedAt，projectId 加唯一约束。
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ProjectInvite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "ProjectInvite_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- 同一项目的历史多条只留一条：未撤销的优先，其次取最新创建的
INSERT INTO "new_ProjectInvite" ("id", "projectId", "token", "role", "createdById", "createdAt", "expiresAt")
SELECT "id", "projectId", "token", "role", "createdById", "createdAt", "expiresAt"
FROM "ProjectInvite"
WHERE "id" IN (
    SELECT "id" FROM (
        SELECT "id", ROW_NUMBER() OVER (
            PARTITION BY "projectId"
            ORDER BY ("revokedAt" IS NULL) DESC, "createdAt" DESC
        ) AS rn
        FROM "ProjectInvite"
    ) WHERE rn = 1
);
DROP TABLE "ProjectInvite";
ALTER TABLE "new_ProjectInvite" RENAME TO "ProjectInvite";
CREATE UNIQUE INDEX "ProjectInvite_projectId_key" ON "ProjectInvite"("projectId");
CREATE UNIQUE INDEX "ProjectInvite_token_key" ON "ProjectInvite"("token");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
