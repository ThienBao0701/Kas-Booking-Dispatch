/**
 * Deterministic development demo-data generator + safe cleaner. Development only
 * (callers are gated by `devToolsEnabled`). Every business row it creates is
 * tagged `isDemo = true` + a `demoBatchId`, so it can never be confused with real
 * data and can be deleted reliably. It uses obviously-fictional values and never
 * invokes real OCR/comparison — proof/OCR/comparison rows are safe fakes.
 */
import fsp from 'node:fs/promises';
import type { BookingStatus, IssueCategory, IssueStatus, PaymentStatus, Prisma, PrismaClient, ProofStatus, VerificationStatus } from '@prisma/client';
import { prisma as defaultPrisma } from '../db/prisma';
import { ApiError } from '../lib/errors';
import { getClock } from '../lib/clock';
import { generateStoredFileName, resolveProofPath, saveProofFile } from '../booking/proofStorage';
import { generateIssuePhotoName, resolveIssuePhotoPath, saveIssuePhoto } from '../issue/issueStorage';
import { ensureTestReceptionist } from './testAccount';
import { MAX_BOOKINGS_PER_BRANCH, MAX_ISSUES_PER_BRANCH } from './constants';
import { makeRng } from './rng';

export interface GenerateParams {
  bookingsPerBranch: number;
  issuesPerBranch: number;
  includeProofs: boolean;
  includeOcr: boolean;
  includeComparisons: boolean;
  seed: number;
}

export interface GenerateSummary {
  batchId: string;
  branches: number;
  bookingsCreated: number;
  issuesCreated: number;
  proofsCreated: number;
  analysesCreated: number;
  comparisonsCreated: number;
  notificationsCreated: number;
  perBranch: { branchId: number; address: string; bookings: number; issues: number }[];
}

/** A minimal valid PNG-signature buffer — enough for magic-byte sniffing. */
function demoPng(): Buffer {
  const buf = Buffer.alloc(64, 0);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf);
  return buf;
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0');
const utcDay = (d: Date): Date => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);
const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * 86_400_000);

// status / verification profiles so every state appears across a branch's set.
const PROFILES: { status: BookingStatus; vs: VerificationStatus; proof: ProofStatus | null; sent: boolean }[] = [
  { status: 'NEW', vs: 'NOT_SUBMITTED', proof: null, sent: true },
  { status: 'NEW', vs: 'PENDING_REVIEW', proof: 'PENDING_REVIEW', sent: true },
  { status: 'NEW', vs: 'REJECTED', proof: 'REJECTED', sent: true },
  { status: 'COMPLETED', vs: 'APPROVED', proof: 'APPROVED', sent: true },
  { status: 'READY', vs: 'NOT_SUBMITTED', proof: null, sent: false },
  { status: 'DRAFT', vs: 'NOT_SUBMITTED', proof: null, sent: false },
];
const CATEGORIES: IssueCategory[] = ['DOOR', 'AIR_CONDITIONER', 'TOILET', 'TV', 'WIFI', 'ELECTRICITY', 'WATER', 'FURNITURE', 'HOUSEKEEPING', 'GUEST_REQUEST', 'OTHER'];
const ISSUE_STATUSES: IssueStatus[] = ['NEW', 'IN_PROGRESS', 'COMPLETED'];

/**
 * Generates demo data across all active branches. Deterministic for a given seed.
 */
export async function generateDemoData(params: GenerateParams, adminId: number, client: PrismaClient = defaultPrisma): Promise<GenerateSummary> {
  if (params.bookingsPerBranch < 0 || params.bookingsPerBranch > MAX_BOOKINGS_PER_BRANCH) {
    throw ApiError.validation(`Số booking mỗi chi nhánh phải trong khoảng 0–${MAX_BOOKINGS_PER_BRANCH}.`);
  }
  if (params.issuesPerBranch < 0 || params.issuesPerBranch > MAX_ISSUES_PER_BRANCH) {
    throw ApiError.validation(`Số sự cố mỗi chi nhánh phải trong khoảng 0–${MAX_ISSUES_PER_BRANCH}.`);
  }

  const rng = makeRng(params.seed);
  const now = getClock().now();
  const today = utcDay(now);
  const reporter = await ensureTestReceptionist(client);
  const branches = await client.branch.findMany({ where: { active: true }, orderBy: { id: 'asc' } });

  const batch = await client.demoDataBatch.create({
    data: { paramsJson: JSON.stringify(params), summaryJson: '{}', createdByUserId: adminId },
  });
  const batchId = batch.id;

  let bookingsCreated = 0;
  let issuesCreated = 0;
  let proofsCreated = 0;
  let analysesCreated = 0;
  let comparisonsCreated = 0;
  let notificationsCreated = 0;
  let globalSeq = 0;
  const perBranch: GenerateSummary['perBranch'] = [];

  for (let b = 0; b < branches.length; b++) {
    const branch = branches[b]!;
    let branchBookings = 0;
    let branchIssues = 0;

    for (let i = 0; i < params.bookingsPerBranch; i++) {
      globalSeq++;
      const profile = PROFILES[i % PROFILES.length]!;
      const rooms = i % 3 === 0 ? 2 : 1;
      const nights = 1 + (i % 3);
      const lastMinute = profile.status === 'NEW' && i % 5 === 0;
      const checkIn = lastMinute ? today : addDays(today, 3 + (i % 20));
      const checkOut = addDays(checkIn, nights);
      const nightly = 500_000 + rng.int(0, 6) * 50_000;
      const payment: PaymentStatus = i % 2 === 0 ? 'PAY_BEFORE' : 'PAY_AFTER';
      const businessType = i % 7 === 0 ? 'UNKNOWN' : i % 2 === 0 ? 'PARTNER' : 'DIRECT';
      const hasPhone = i % 4 !== 0;
      const arrival = i % 3 === 0 ? `Khách dự kiến đến khoảng ${13 + (i % 6)}:00.` : null;
      const bookingCode = `TST${pad(globalSeq, 8)}`;

      const stayDates = Array.from({ length: nights }, (_, n) => addDays(checkIn, n));
      const roomData: Prisma.BookingRoomCreateWithoutBookingInput[] = Array.from({ length: rooms }, (_, r) => ({
        roomIndex: r + 1,
        roomType: rng.pick(['Standard Double Room', 'Superior Double', 'Deluxe Double', 'Family Room']),
        roomSubtotal: nightly * nights,
        nights: { create: stayDates.map((d) => ({ stayDate: d, amount: nightly, currency: 'VND' })) },
      }));

      const booking = await client.booking.create({
        data: {
          bookingCode,
          hotelName: branch.hotelName,
          branchId: branch.id,
          customerName: `TEST Nguyễn Văn ${pad(globalSeq, 3)}`,
          phone: hasPhone ? `0900000${pad(globalSeq % 1000, 3)}` : null,
          checkInDate: checkIn,
          checkOutDate: checkOut,
          totalAmount: nightly * nights * rooms,
          currency: 'VND',
          paymentStatus: payment,
          businessType,
          businessTypeConfidence: businessType === 'UNKNOWN' ? null : 80,
          specialRequest: arrival,
          rawText: 'DEMO DATA (fictional)',
          status: profile.status,
          verificationStatus: profile.vs,
          isLastMinute: lastMinute,
          parserVersion: 'demo',
          isDemo: true,
          demoBatchId: batchId,
          sentAt: profile.sent ? now : null,
          sentByUserId: profile.sent ? adminId : null,
          completedByUserId: profile.proof ? reporter.id : null,
          completedAt: profile.proof ? now : null,
          reviewedByUserId: profile.vs === 'APPROVED' || profile.vs === 'REJECTED' ? adminId : null,
          reviewedAt: profile.vs === 'APPROVED' || profile.vs === 'REJECTED' ? now : null,
          rooms: { create: roomData },
        },
      });
      bookingsCreated++;
      branchBookings++;

      if (params.includeProofs && profile.proof) {
        const storedFileName = generateStoredFileName(booking.id, 1, 'image/png');
        await saveProofFile(demoPng(), storedFileName);
        const proof = await client.bookingCreationProof.create({
          data: {
            bookingId: booking.id,
            attemptNumber: 1,
            storedFileName,
            originalFileName: 'demo-proof.png',
            mimeType: 'image/png',
            fileSize: 64,
            submittedByUserId: reporter.id,
            status: profile.proof,
            reviewReasonCode: profile.proof === 'REJECTED' ? 'WRONG_DATES' : null,
            reviewedByUserId: profile.proof === 'APPROVED' || profile.proof === 'REJECTED' ? adminId : null,
            reviewedAt: profile.proof === 'APPROVED' || profile.proof === 'REJECTED' ? now : null,
          },
        });
        proofsCreated++;

        if (params.includeOcr) {
          const fakeFields = {
            bookingCode: { value: bookingCode, confidence: 95 },
            customerName: { value: `TEST Nguyen Van ${pad(globalSeq, 3)}`, confidence: 80 },
            checkInDate: { value: checkIn.toISOString().slice(0, 10), confidence: 90 },
            checkOutDate: { value: checkOut.toISOString().slice(0, 10), confidence: 88 },
            nights: { value: nights, confidence: 82 },
            roomTypes: [{ value: 'Superior Double', quantity: rooms, confidence: 78 }],
            roomQuantity: { value: rooms, confidence: 80 },
            totalAmount: { value: nightly * nights * rooms, currency: 'VND', confidence: 92 },
            paymentStatus: { value: payment, confidence: 84 },
            note: null,
          };
          const analysis = await client.bookingProofAnalysis.create({
            data: {
              proofId: proof.id,
              status: 'COMPLETED',
              provider: 'demo',
              analysisVersion: '1',
              extractedText: `DEMO OCR ${bookingCode}`,
              extractedDataJson: JSON.stringify(fakeFields),
              startedAt: now,
              completedAt: now,
            },
          });
          analysesCreated++;

          if (params.includeComparisons) {
            const overall = rng.pick(['MATCH', 'WARNING', 'MISMATCH', 'UNAVAILABLE'] as const);
            await client.bookingProofComparison.create({
              data: {
                bookingId: booking.id,
                proofId: proof.id,
                analysisId: analysis.id,
                overallStatus: overall,
                comparisonVersion: 'proof-compare-v1',
                resultJson: JSON.stringify({ overall, version: 'proof-compare-v1', summary: { matchCount: 5, mismatchCount: overall === 'MISMATCH' ? 1 : 0, warningCount: overall === 'WARNING' ? 2 : 0, notFoundCount: 0 }, fields: [] }),
                createdByUserId: null,
              },
            });
            comparisonsCreated++;
          }
        }

        // A demo notification to the admin about the pending proof.
        if (profile.proof === 'PENDING_REVIEW') {
          await client.notification.create({
            data: { userId: adminId, bookingId: booking.id, title: 'Có đơn chờ kiểm tra', body: `${bookingCode} — ${branch.address}`, isDemo: true, demoBatchId: batchId },
          });
          notificationsCreated++;
        }
      }
    }

    for (let j = 0; j < params.issuesPerBranch; j++) {
      const status = ISSUE_STATUSES[j % ISSUE_STATUSES.length]!;
      const category = CATEGORIES[j % CATEGORIES.length]!;
      const issue = await client.hotelIssue.create({
        data: {
          branchId: branch.id,
          // Demo rows exercise the structured form: every one is a ROOM incident.
          areaCategory: 'ROOM',
          roomNumber: `TEST-${b + 1}${pad(j, 2)}`,
          category,
          description: `Sự cố demo: ${category} tại phòng test (chi nhánh ${branch.address}).`,
          status,
          reportedByUserId: reporter.id,
          reportedByNameSnapshot: reporter.fullName,
          acceptedByUserId: status === 'IN_PROGRESS' || status === 'COMPLETED' ? adminId : null,
          acceptedAt: status === 'IN_PROGRESS' || status === 'COMPLETED' ? now : null,
          technicianName: status === 'IN_PROGRESS' || status === 'COMPLETED' ? 'Kỹ thuật viên demo' : null,
          technicianPhone: status === 'IN_PROGRESS' || status === 'COMPLETED' ? '0900000000' : null,
          completedByUserId: status === 'COMPLETED' ? adminId : null,
          completedAt: status === 'COMPLETED' ? now : null,
          isDemo: true,
          demoBatchId: batchId,
        },
      });
      issuesCreated++;
      branchIssues++;

      if (j % 4 === 0) {
        const photoName = generateIssuePhotoName(issue.id, 'image/png');
        await saveIssuePhoto(demoPng(), photoName);
        await client.hotelIssue.update({ where: { id: issue.id }, data: { photoStoredName: photoName, photoMimeType: 'image/png' } });
      }
    }

    perBranch.push({ branchId: branch.id, address: branch.address, bookings: branchBookings, issues: branchIssues });
  }

  const summary: GenerateSummary = { batchId, branches: branches.length, bookingsCreated, issuesCreated, proofsCreated, analysesCreated, comparisonsCreated, notificationsCreated, perBranch };
  await client.demoDataBatch.update({ where: { id: batchId }, data: { summaryJson: JSON.stringify(summary) } });
  return summary;
}

export interface ClearSummary {
  batchesDeleted: number;
  bookingsDeleted: number;
  issuesDeleted: number;
  /** Journal entries that referenced a demo incident and went with it. */
  operationalReportsDeleted: number;
  notificationsDeleted: number;
  proofFilesDeleted: number;
  issuePhotosDeleted: number;
}

async function unlinkQuietly(path: string): Promise<boolean> {
  try {
    await fsp.unlink(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes ONLY demo-tagged data. Physical proof/issue files are removed first
 * (collected before the DB rows cascade away), then demo bookings (cascading to
 * rooms/nights/proofs/analyses/comparisons/history), demo issues, demo
 * notifications and demo batches. Real data is never touched.
 */
export async function clearDemoData(client: PrismaClient = defaultPrisma): Promise<ClearSummary> {
  // Collect physical files before the rows disappear.
  const demoProofs = await client.bookingCreationProof.findMany({ where: { booking: { isDemo: true } }, select: { storedFileName: true } });
  const demoIssues = await client.hotelIssue.findMany({ where: { isDemo: true }, select: { photoStoredName: true } });

  let proofFilesDeleted = 0;
  for (const p of demoProofs) {
    if (await unlinkQuietly(resolveProofPath(p.storedFileName))) proofFilesDeleted++;
  }
  let issuePhotosDeleted = 0;
  for (const it of demoIssues) {
    if (it.photoStoredName && (await unlinkQuietly(resolveIssuePhotoPath(it.photoStoredName)))) issuePhotosDeleted++;
  }

  // Demo notifications not attached to a demo booking (issue-related etc).
  const notif = await client.notification.deleteMany({ where: { isDemo: true } });
  // Deleting demo bookings cascades rooms/nights/proofs/analyses/comparisons/history + booking notifications.
  const bookings = await client.booking.deleteMany({ where: { isDemo: true } });
  /*
    A JOURNAL ENTRY POINTING AT A DEMO INCIDENT IS ITSELF DEMO-DERIVED.

    "Sự cố cơ sở vật chất" holds a RESTRICT reference to HotelIssue, so the
    delete below throws P2003 while such an entry exists — and the entry has no
    meaning without the incident it references anyway. Deleting the REPORT (not
    just its detail row) cascades to the detail and to the entry's audit rows.

    Only entries about DEMO incidents are removed. A real entry cannot be
    affected, because a real incident is never `isDemo`.
  */
  const facilityReports = await client.receptionOperationalReport.deleteMany({
    where: { facility: { is: { issue: { is: { isDemo: true } } } } },
  });
  const issues = await client.hotelIssue.deleteMany({ where: { isDemo: true } });
  const batches = await client.demoDataBatch.deleteMany({});

  return {
    batchesDeleted: batches.count,
    bookingsDeleted: bookings.count,
    issuesDeleted: issues.count,
    operationalReportsDeleted: facilityReports.count,
    notificationsDeleted: notif.count,
    proofFilesDeleted,
    issuePhotosDeleted,
  };
}
