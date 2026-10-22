-- ROOM SERVICE "REVIEW": a manual KPI count, not a sale.
--
-- ADDITIVE ONLY. One enum value and two nullable columns. No row is rewritten
-- and nothing is backfilled: every existing service keeps NULL counts, which is
-- what it means — it is not a review.
--
-- RoomServiceType.REVIEW                  the new service type.
-- RoomServiceReport."tripadvisorCount"    reviews on Tripadvisor, as the
--                                         receptionist reports them (>= 0).
-- RoomServiceReport."googleCount"         reviews on Google, likewise.
--
-- A Review row stores price 0 and is never counted as revenue; the reception
-- overview's "Tổng đánh giá (review)" is SUM(tripadvisorCount + googleCount)
-- over the live (non-voided) Review rows.
--
-- PostgreSQL allows ALTER TYPE ... ADD VALUE inside a transaction block (12+),
-- as long as the new value is not used in the same transaction — and nothing
-- here uses it.

-- AlterEnum
ALTER TYPE "RoomServiceType" ADD VALUE IF NOT EXISTS 'REVIEW';

-- AlterTable
ALTER TABLE "RoomServiceReport" ADD COLUMN     "googleCount" INTEGER,
ADD COLUMN     "tripadvisorCount" INTEGER;
