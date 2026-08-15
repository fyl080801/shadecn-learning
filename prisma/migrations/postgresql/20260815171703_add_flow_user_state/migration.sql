-- CreateTable
CREATE TABLE "FlowUserState" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlowUserState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FlowUserState_userId_idx" ON "FlowUserState"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "FlowUserState_flowId_userId_key_key" ON "FlowUserState"("flowId", "userId", "key");

-- AddForeignKey
ALTER TABLE "FlowUserState" ADD CONSTRAINT "FlowUserState_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowUserState" ADD CONSTRAINT "FlowUserState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
