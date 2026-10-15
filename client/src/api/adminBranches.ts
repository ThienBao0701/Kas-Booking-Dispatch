import { api } from './client';

export type AliasSource = 'BOOKING_COM' | 'AGODA' | 'MANUAL' | 'OTHER';
export type AliasMatchMode = 'EXACT' | 'SIMILARITY';

export const ALIAS_SOURCE_LABEL: Record<AliasSource, string> = {
  BOOKING_COM: 'Booking.com',
  AGODA: 'Agoda',
  MANUAL: 'Nhập tay',
  OTHER: 'Nguồn khác',
};

export interface BranchAlias {
  id: number;
  source: AliasSource;
  alias: string;
  normalizedAlias: string;
  matchMode: AliasMatchMode;
  active: boolean;
  priority: number;
}

export interface AdminBranch {
  id: number;
  branchNumber: number;
  code: string;
  hotelName: string;
  address: string;
  breakfastIncluded: boolean;
  active: boolean;
  phone: string | null;
  email: string | null;
  contactName: string | null;
  note: string | null;
  aliases: BranchAlias[];
  receptionistCount: number;
  activeReceptionistCount: number;
  createdAt: string;
  updatedAt: string;
}

/** An alias typed into the add-branch form, before the branch exists. */
export interface NewAliasInput {
  source: AliasSource;
  alias: string;
  matchMode?: AliasMatchMode;
}

export interface CreateBranchInput {
  branchNumber: number;
  hotelName: string;
  address: string;
  code: string;
  breakfastIncluded: boolean;
  active: boolean;
  phone?: string | null;
  email?: string | null;
  contactName?: string | null;
  note?: string | null;
  aliases?: NewAliasInput[];
}

export type UpdateBranchInput = Partial<
  Pick<
    CreateBranchInput,
    'branchNumber' | 'hotelName' | 'address' | 'breakfastIncluded' | 'active' | 'phone' | 'email' | 'contactName' | 'note'
  >
>;

export interface AffectedReceptionist {
  id: number;
  username: string;
  fullName: string;
  active: boolean;
}

export interface BranchHistoryEntry {
  id: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  changedBy: { id: number; fullName: string } | null;
  changedAt: string;
}

/* ------------------------------------------------------------------ */
/* Platform identities — one current hotel name per platform           */
/* ------------------------------------------------------------------ */

/** The five platforms a branch can be listed on. Order drives the UI rows. */
export const OTA_PLATFORMS = [
  'BOOKING_COM',
  'AGODA',
  'CTRIP',
  'TRIPADVISOR',
  'TRAVELOKA',
] as const;

export type OtaPlatform = (typeof OTA_PLATFORMS)[number];

export const PLATFORM_LABEL: Record<OtaPlatform, string> = {
  BOOKING_COM: 'Booking.com',
  AGODA: 'Agoda',
  CTRIP: 'CTrip',
  TRIPADVISOR: 'Tripadvisor',
  TRAVELOKA: 'Traveloka',
};

/** One platform row. `name === null` means "Chưa thiết lập". */
export interface PlatformIdentity {
  platform: OtaPlatform;
  name: string | null;
  normalizedName: string | null;
  /** The migration had to choose between competing legacy names. */
  needsConfirmation: boolean;
  updatedAt: string | null;
}

export interface IdentityHistoryEntry {
  id: string;
  platform: OtaPlatform;
  action: string;
  oldValue: string | null;
  newValue: string | null;
  reason: string | null;
  actor: { id: number; fullName: string } | null;
  correlationId: string | null;
  createdAt: string;
}

export const adminBranchesApi = {
  list: () => api.get<{ branches: AdminBranch[] }>('/admin/branches'),
  get: (id: number) => api.get<{ branch: AdminBranch }>(`/admin/branches/${id}`),
  suggestCode: (address: string) =>
    api.get<{ code: string }>(`/admin/branches/suggest-code?address=${encodeURIComponent(address)}`),
  create: (input: CreateBranchInput) => api.post<{ branch: AdminBranch }>('/admin/branches', input),
  update: (id: number, input: UpdateBranchInput) =>
    api.patch<{ branch: AdminBranch }>(`/admin/branches/${id}`, input),
  // --- Platform identities (replaces the alias mutations) ---
  identities: (id: number) =>
    api.get<{ identities: PlatformIdentity[] }>(`/admin/branches/${id}/platform-identities`),
  setIdentity: (id: number, platform: OtaPlatform, name: string) =>
    api.put<{ identities: PlatformIdentity[] }>(
      `/admin/branches/${id}/platform-identities/${platform}`,
      { name },
    ),
  deleteIdentity: (id: number, platform: OtaPlatform) =>
    api.del<{ identities: PlatformIdentity[] }>(
      `/admin/branches/${id}/platform-identities/${platform}`,
    ),
  confirmIdentity: (id: number, platform: OtaPlatform) =>
    api.post<{ identities: PlatformIdentity[] }>(
      `/admin/branches/${id}/platform-identities/${platform}/confirm`,
    ),
  identityHistory: (id: number) =>
    api.get<{ history: IdentityHistoryEntry[] }>(`/admin/branches/${id}/identity-history`),
  activate: (id: number) => api.post<{ branch: AdminBranch }>(`/admin/branches/${id}/activate`),
  deactivate: (id: number) =>
    api.post<{ branch: AdminBranch; affectedReceptionists: AffectedReceptionist[] }>(
      `/admin/branches/${id}/deactivate`,
    ),
  receptionists: (id: number) =>
    api.get<{ receptionists: AffectedReceptionist[] }>(`/admin/branches/${id}/receptionists`),
  history: (id: number) => api.get<{ history: BranchHistoryEntry[] }>(`/admin/branches/${id}/history`),
};
