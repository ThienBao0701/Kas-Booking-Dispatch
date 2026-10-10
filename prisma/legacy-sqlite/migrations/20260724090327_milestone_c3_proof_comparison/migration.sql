-- CreateTable
CREATE TABLE "BookingProofComparison" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bookingId" TEXT NOT NULL,
    "proofId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "overallStatus" TEXT NOT NULL,
    "comparisonVersion" TEXT NOT NULL,
    "resultJson" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdByUserId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BookingProofComparison_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BookingProofComparison_proofId_fkey" FOREIGN KEY ("proofId") REFERENCES "BookingCreationProof" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BookingProofComparison_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "BookingProofAnalysis" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BookingProofComparison_proofId_idx" ON "BookingProofComparison"("proofId");

-- CreateIndex
CREATE INDEX "BookingProofComparison_bookingId_idx" ON "BookingProofComparison"("bookingId");

-- CreateIndex
CREATE INDEX "BookingProofComparison_createdAt_idx" ON "BookingProofComparison"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BookingProofComparison_analysisId_comparisonVersion_key" ON "BookingProofComparison"("analysisId", "comparisonVersion");
