-- GUEST REQUEST: "Số phòng" and "Cách xử lý"
--
-- Two nullable columns on "GuestRequestReport", nothing else. No column is
-- renamed or dropped and no existing row is rewritten.
--
-- The completion event keeps its V3 column names ("acceptedAt" and siblings);
-- the Prisma schema maps them to `completed…` fields, so this migration does not
-- touch them.
--
-- NO CHECK CONSTRAINT tying "resolution" to "acceptedAt": requests completed
-- under V3 have a completion time and no resolution, and a constraint would
-- refuse them. The service requires a resolution on every completion from now
-- on.

ALTER TABLE "GuestRequestReport" ADD COLUMN "roomNumber" TEXT;
ALTER TABLE "GuestRequestReport" ADD COLUMN "resolution" TEXT;
