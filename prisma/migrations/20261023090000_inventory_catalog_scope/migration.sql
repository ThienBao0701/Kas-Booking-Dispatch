-- SHARED AND BRANCH CATALOG ITEMS, ONE CODE NUMBERING FOR THE SYSTEM.
-- ADDITIVE: no row is deleted, no code renumbered, no balance or movement
-- touched. Every existing item was created by its branch, so it stays BRANCH.

-- CreateEnum
CREATE TYPE "InventoryItemScope" AS ENUM ('SYSTEM', 'BRANCH');

-- AlterTable
ALTER TABLE "InventoryItem" ADD COLUMN "scope" "InventoryItemScope" NOT NULL DEFAULT 'BRANCH';

-- CreateTable
CREATE TABLE "InventoryGlobalCodeSequence" (
    "warehouse" "InventoryWarehouse" NOT NULL,
    "lastNumber" INTEGER NOT NULL,

    CONSTRAINT "InventoryGlobalCodeSequence_pkey" PRIMARY KEY ("warehouse")
);

-- Each warehouse's shared numbering starts after the highest number any branch
-- has used — its sequence or a code on file — so no code is ever issued twice.
INSERT INTO "InventoryGlobalCodeSequence" ("warehouse", "lastNumber")
SELECT w, MAX(n) FROM (
  SELECT "warehouse" AS w, "lastNumber" AS n FROM "InventoryCodeSequence"
  UNION ALL
  SELECT "warehouse", CAST(SUBSTRING("code" FROM '^[0-9]+\.([0-9]+)$') AS INTEGER)
  FROM "InventoryItem" WHERE "code" ~ '^[0-9]+\.[0-9]+$'
) t
GROUP BY w;
