-- Housekeeping WORK ITEMS, continued: "one open task per room and business
-- day" becomes one open task per room, day and ITEM — so room 502 can carry an
-- "OC" and a "Khác" at once, each accepted, inspected and cleaned on its own.
--
-- Index only, forward-only, no data touched. Every existing row has itemKey ''
-- (20261014090000), so for the rows on file the new index enforces exactly what
-- the old one did: one open legacy item per room and day. The second index keeps
-- the room's OUT / OC / VC single while open — what the old index guaranteed for
-- those codes — now also against a racing "Tạo công việc". Both are created
-- before the old index is dropped, so the table is never without its guard.

CREATE UNIQUE INDEX "HousekeepingRoomTask_one_open_per_item_day"
  ON "HousekeepingRoomTask" ("branchId", "workDate", "roomNumber", "itemKey")
  WHERE "voidedAt" IS NULL AND "reviewResult" IS NULL;

CREATE UNIQUE INDEX "HousekeepingRoomTask_one_open_code_per_room_day"
  ON "HousekeepingRoomTask" ("branchId", "workDate", "roomNumber", "statusCode")
  WHERE "voidedAt" IS NULL AND "reviewResult" IS NULL AND "areaKind" = 'ROOM' AND "statusCode" <> 'OTHER';

DROP INDEX "HousekeepingRoomTask_one_open_per_room_day";
