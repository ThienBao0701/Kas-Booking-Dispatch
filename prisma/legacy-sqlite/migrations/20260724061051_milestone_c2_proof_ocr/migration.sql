-- CreateTable
CREATE TABLE "BookingProofAnalysis" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "proofId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "analysisVersion" TEXT NOT NULL,
    "extractedText" TEXT,
    "extractedDataJson" TEXT,
    "errorMessage" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BookingProofAnalysis_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "BookingCreationProof" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BookingProofAnalysis_proofId_idx" ON "BookingProofAnalysis"("proofId");

-- CreateIndex
CREATE INDEX "BookingProofAnalysis_proofId_status_idx" ON "BookingProofAnalysis"("proofId", "status");

-- CreateIndex
CREATE INDEX "BookingProofAnalysis_createdAt_idx" ON "BookingProofAnalysis"("createdAt");
