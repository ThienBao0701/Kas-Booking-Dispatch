import { api } from './client';

export type RoomMappingStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
export type RoomClassAliasSource = 'SEED' | 'ADMIN' | 'PARSER';

export interface RoomClassAliasView {
  id: string;
  alias: string;
  source: RoomClassAliasSource;
  active: boolean;
}

export interface RoomClassView {
  id: string;
  stableKey: string;
  displayName: string;
  normalizedName: string;
  pmsCode: string;
  active: boolean;
  sortOrder: number;
  aliases: RoomClassAliasView[];
  updatedAt: string;
}

export interface RoomMappingVersionView {
  id: string;
  branchId: number;
  versionNumber: number;
  status: RoomMappingStatus;
  changeReason: string | null;
  createdAt: string;
  activatedAt: string | null;
  archivedAt: string | null;
  createdBy: { id: number; fullName: string } | null;
  activatedBy: { id: number; fullName: string } | null;
  roomClasses: RoomClassView[];
}

export interface DraftValidation {
  ok: boolean;
  problems: { code: string; message: string; roomClassId?: string }[];
  activeClassCount: number;
}

export interface ActivationSummary {
  version: RoomMappingVersionView;
  previousVersionNumber: number | null;
  added: string[];
  changed: string[];
  deactivated: string[];
}

/** What one room name resolves to at one branch, without anything being stored. */
export interface RoomClassResolution {
  sourceRoomName: string | null;
  status: 'RESOLVED' | 'MANUAL' | 'UNRESOLVED' | 'LEGACY';
  roomClassId: string | null;
  displayName: string | null;
  pmsCode: string | null;
  matchedAlias: string | null;
  matchType: 'DISPLAY_NAME' | 'ALIAS' | 'EXPLICIT_ID' | 'NONE';
}

const base = (branchId: number) => `/admin/branches/${branchId}/room-mapping`;

export const roomMappingApi = {
  get: (branchId: number) =>
    api.get<{ active: RoomMappingVersionView | null; draft: RoomMappingVersionView | null }>(base(branchId)),
  /**
   * Pre-fills the room-class picker for a review that has no booking yet.
   *
   * A read, not a write: it creates no Booking and no snapshot. What comes back
   * is a suggestion for the Admin to confirm — the authoritative resolution
   * happens server-side when the order is dispatched.
   */
  resolve: (branchId: number, roomNames: (string | null)[]) =>
    api.post<{ versionId: string | null; rooms: RoomClassResolution[] }>(`${base(branchId)}/resolve`, {
      roomNames,
    }),
  versions: (branchId: number) =>
    api.get<{ versions: RoomMappingVersionView[] }>(`${base(branchId)}/versions`),
  createDraft: (branchId: number, changeReason?: string) =>
    api.post<{ draft: RoomMappingVersionView }>(`${base(branchId)}/drafts`, { changeReason }),
  addRoomClass: (
    branchId: number,
    draftId: string,
    input: { displayName: string; pmsCode: string; aliases?: string[] },
  ) => api.post<{ draft: RoomMappingVersionView }>(`${base(branchId)}/drafts/${draftId}/room-classes`, input),
  updateRoomClass: (
    branchId: number,
    draftId: string,
    roomClassId: string,
    patch: { displayName?: string; pmsCode?: string; active?: boolean; sortOrder?: number },
  ) =>
    api.patch<{ draft: RoomMappingVersionView }>(
      `${base(branchId)}/drafts/${draftId}/room-classes/${roomClassId}`,
      patch,
    ),
  addAlias: (branchId: number, draftId: string, roomClassId: string, alias: string) =>
    api.post<{ draft: RoomMappingVersionView }>(
      `${base(branchId)}/drafts/${draftId}/room-classes/${roomClassId}/aliases`,
      { alias },
    ),
  removeAlias: (branchId: number, draftId: string, aliasId: string) =>
    api.del<{ draft: RoomMappingVersionView }>(`${base(branchId)}/drafts/${draftId}/aliases/${aliasId}`),
  validate: (branchId: number, draftId: string) =>
    api.post<DraftValidation>(`${base(branchId)}/drafts/${draftId}/validate`),
  activate: (branchId: number, draftId: string, expectedActiveVersionId: string | null, changeReason?: string) =>
    api.post<ActivationSummary>(`${base(branchId)}/drafts/${draftId}/activate`, {
      expectedActiveVersionId,
      changeReason,
    }),
  cancelDraft: (branchId: number, draftId: string) =>
    api.del<{ success: true }>(`${base(branchId)}/drafts/${draftId}`),
};

/* ------------------------------------------------------------------ */
/* Booking guests                                                      */
/* ------------------------------------------------------------------ */

export interface GuestView {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  nationality: string | null;
  identityNumber: string | null;
  identityType: string | null;
  note: string | null;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** Only the keys actually sent are changed; omitted keys are preserved. */
export type GuestPatch = Partial<
  Pick<GuestView, 'fullName' | 'phone' | 'email' | 'nationality' | 'identityNumber' | 'identityType' | 'note'>
> & { expectedUpdatedAt?: string };

export const bookingGuestsApi = {
  list: (bookingId: string) => api.get<{ guests: GuestView[] }>(`/bookings/${bookingId}/guests`),
  add: (bookingId: string, input: GuestPatch & { fullName: string }) =>
    api.post<{ guests: GuestView[] }>(`/bookings/${bookingId}/guests`, input),
  update: (bookingId: string, guestId: string, patch: GuestPatch) =>
    api.patch<{ guests: GuestView[] }>(`/bookings/${bookingId}/guests/${guestId}`, patch),
  remove: (bookingId: string, guestId: string) =>
    api.del<{ guests: GuestView[] }>(`/bookings/${bookingId}/guests/${guestId}`),
  setPrimary: (bookingId: string, guestId: string) =>
    api.post<{ guests: GuestView[] }>(`/bookings/${bookingId}/guests/${guestId}/primary`),
  audit: (bookingId: string) =>
    api.get<{ events: { id: string; action: string; field: string | null; oldValue: string | null; newValue: string | null; reason: string | null; actor: { id: number; fullName: string } | null; createdAt: string }[] }>(
      `/bookings/${bookingId}/audit`,
    ),
};
