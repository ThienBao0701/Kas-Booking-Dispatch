/**
 * WHICH LOCATION FIELDS AN INCIDENT MUST CARRY, BY AREA.
 *
 * This is the whole of the "the form changes depending on the area" rule, in one
 * place, on the server. The React form reads the same table to decide which
 * inputs to RENDER; it does not decide what is VALID. That split matters: a form
 * that both renders and validates is a form whose rules can be skipped with
 * curl, and this data is the basis of a maintenance report.
 *
 * Reading the table:
 *   roomNumber     required for ROOM, refused everywhere else
 *   floorNumber    required for HALLWAY and STAIRCASE, refused everywhere else
 *   areaSubtype    required for LOBBY, refused everywhere else
 *   locationDetail required for OTHER_AREA (and for LOBBY/OTHER, see below),
 *                  optional elsewhere
 *   category       optional everywhere — a hallway report is a place plus a
 *                  description, and the receptionist is not asked to classify it
 *
 * WHY "KHÁC" STILL HAS TO SAY SOMETHING
 *
 * LOBBY + OTHER, and OTHER_AREA, both mean "not on the list". Left alone they
 * produce a report that says only that something, somewhere, is broken. Both
 * therefore require `locationDetail` — the one extra sentence that makes the
 * report actionable — rather than a new enum branch nobody asked for.
 */
import type { IssueAreaCategory, IssueAreaSubtype } from '@prisma/client';
import { ApiError } from '../lib/errors';

export const ISSUE_AREA_LABELS: Record<IssueAreaCategory, string> = {
  ROOM: 'Phòng',
  LOBBY: 'Khu Vực Sảnh',
  HALLWAY: 'Khu Vực Hành Lang',
  STAIRCASE: 'Khu Vực Cầu Thang',
  RESTAURANT: 'Khu Vực Nhà Hàng',
  ROOFTOP: 'Khu Vực Rooftop',
  OTHER_AREA: 'Các Khu Vực Còn Lại',
};

export const ISSUE_AREA_SUBTYPE_LABELS: Record<IssueAreaSubtype, string> = {
  RECEPTION_DESK: 'Quầy lễ tân',
  SOFA: 'Sofa',
  FLOOR: 'Nền nhà',
  CEILING: 'Trần nhà',
  LIGHT_BULB: 'Bóng đèn',
  CLOCK: 'Đồng hồ',
  OTHER: 'Khác',
};

/** Declaration order is the order the areas are offered in the form. */
export const ISSUE_AREA_CATEGORIES: readonly IssueAreaCategory[] = [
  'ROOM',
  'LOBBY',
  'HALLWAY',
  'STAIRCASE',
  'RESTAURANT',
  'ROOFTOP',
  'OTHER_AREA',
];

export const ISSUE_AREA_SUBTYPES: readonly IssueAreaSubtype[] = [
  'RECEPTION_DESK',
  'SOFA',
  'FLOOR',
  'CEILING',
  'LIGHT_BULB',
  'CLOCK',
  'OTHER',
];

export interface AreaFieldRules {
  roomNumber: boolean;
  floorNumber: boolean;
  areaSubtype: boolean;
  /** Whether a fault type (`category`) is offered at all. */
  category: boolean;
}

/** Which fields this area USES. A field not listed here is refused if sent. */
export const AREA_FIELDS: Record<IssueAreaCategory, AreaFieldRules> = {
  ROOM: { roomNumber: true, floorNumber: false, areaSubtype: false, category: true },
  LOBBY: { roomNumber: false, floorNumber: false, areaSubtype: true, category: false },
  HALLWAY: { roomNumber: false, floorNumber: true, areaSubtype: false, category: false },
  STAIRCASE: { roomNumber: false, floorNumber: true, areaSubtype: false, category: false },
  RESTAURANT: { roomNumber: false, floorNumber: false, areaSubtype: false, category: true },
  ROOFTOP: { roomNumber: false, floorNumber: false, areaSubtype: false, category: true },
  OTHER_AREA: { roomNumber: false, floorNumber: false, areaSubtype: false, category: true },
};

export interface AreaInput {
  areaCategory: IssueAreaCategory;
  roomNumber?: string | null;
  floorNumber?: string | null;
  areaSubtype?: IssueAreaSubtype | null;
  locationDetail?: string | null;
}

/** Trimmed, with empty strings collapsed to null so "   " is never a value. */
export interface NormalisedArea {
  areaCategory: IssueAreaCategory;
  roomNumber: string | null;
  floorNumber: string | null;
  areaSubtype: IssueAreaSubtype | null;
  locationDetail: string | null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Validates the location against its area and returns exactly the columns to
 * store. Fields that do not belong to the area are DROPPED rather than stored:
 * a rooftop incident carrying a room number would otherwise read as a room
 * incident in every report that groups by place.
 */
export function normaliseArea(input: AreaInput): NormalisedArea {
  const rules = AREA_FIELDS[input.areaCategory];
  if (!rules) throw ApiError.validation('Khu vực sự cố không hợp lệ.');

  const roomNumber = clean(input.roomNumber);
  const floorNumber = clean(input.floorNumber);
  const locationDetail = clean(input.locationDetail);
  const areaSubtype = input.areaSubtype ?? null;

  if (rules.roomNumber && !roomNumber) {
    throw ApiError.validation('Vui lòng nhập số phòng.');
  }
  if (rules.floorNumber && !floorNumber) {
    throw ApiError.validation('Vui lòng nhập số tầng.');
  }
  if (rules.areaSubtype && !areaSubtype) {
    throw ApiError.validation('Vui lòng chọn loại sự cố.');
  }
  // "Not on the list" has to say which thing it is, or the report is unusable.
  const needsDetail =
    input.areaCategory === 'OTHER_AREA' || (input.areaCategory === 'LOBBY' && areaSubtype === 'OTHER');
  if (needsDetail && !locationDetail) {
    throw ApiError.validation('Vui lòng mô tả rõ vị trí xảy ra sự cố.');
  }

  return {
    areaCategory: input.areaCategory,
    roomNumber: rules.roomNumber ? roomNumber : null,
    floorNumber: rules.floorNumber ? floorNumber : null,
    areaSubtype: rules.areaSubtype ? areaSubtype : null,
    locationDetail,
  };
}

/**
 * One human-readable line for the place, used by notifications and the PDF.
 * Falls back to the area name alone, so it is never empty.
 */
export function describeLocation(issue: {
  areaCategory: IssueAreaCategory | null;
  roomNumber: string | null;
  floorNumber: string | null;
  areaSubtype: IssueAreaSubtype | null;
  locationDetail: string | null;
}): string {
  // A legacy row has no area; the old free-form room number is all there is.
  if (!issue.areaCategory) {
    return issue.roomNumber ? `Phòng ${issue.roomNumber}` : '—';
  }
  const parts: string[] = [ISSUE_AREA_LABELS[issue.areaCategory]];
  if (issue.roomNumber) parts.push(`Phòng ${issue.roomNumber}`);
  if (issue.floorNumber) parts.push(`Tầng ${issue.floorNumber}`);
  if (issue.areaSubtype) parts.push(ISSUE_AREA_SUBTYPE_LABELS[issue.areaSubtype]);
  if (issue.locationDetail) parts.push(issue.locationDetail);
  return parts.join(' · ');
}
