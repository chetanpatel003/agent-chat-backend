-- CreateTable
CREATE TABLE "RunSkill" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "agentRunId" UUID NOT NULL,
    "skillName" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "loadedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunSkill_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RunSkill_agentRunId_skillName_key" ON "RunSkill"("agentRunId", "skillName");

-- AddForeignKey
ALTER TABLE "RunSkill" ADD CONSTRAINT "RunSkill_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
