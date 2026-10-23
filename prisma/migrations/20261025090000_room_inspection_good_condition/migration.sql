-- "TRANG THIẾT BỊ NỘI THẤT TRONG PHÒNG Ở TRẠNG THÁI TỐT" — an inspection's
-- explicit positive result. ADDITIVE: one column, false on every inspection
-- already on file (they made no such statement); no finding is created by it.
ALTER TABLE "RoomInspection" ADD COLUMN "goodCondition" BOOLEAN NOT NULL DEFAULT false;
