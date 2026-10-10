/**
 * Admin-only hotel & branch management (Milestone C.3.7).
 *
 * Every route here is gated by requireAuth + requirePasswordChanged +
 * requireAdmin, so a receptionist receives 403 on all of them — including the
 * read endpoints, which expose routing configuration.
 */
import { Router } from 'express';
import type { NextFunction, Request } from 'express';
import { z } from 'zod';
import { requireAuth, requireAdmin, requirePasswordChanged } from '../middleware/auth';
import { ApiError } from '../lib/errors';
import {
  activateBranch,
  createBranch,
  createBranchSchema,
  deactivateBranch,
  getBranch,
  listBranchHistory,
  listBranches,
  receptionistsOfBranch,
  suggestBranchCode,
  updateBranch,
  updateBranchSchema,
} from '../branch/branchService';
import {
  confirmIdentity,
  deleteIdentity,
  listIdentities,
  listIdentityHistory,
  parsePlatform,
  setIdentity,
  setIdentitySchema,
  type Actor,
} from '../branch/platformIdentityService';

/**
 * The acting Admin plus the request correlation id, so every identity change is
 * traceable to one HTTP request. Role and id come from the SERVER-loaded
 * session user — never from anything the client sent.
 */
function actorOf(req: Request): Actor {
  return {
    id: req.currentUser?.id ?? null,
    role: req.currentUser?.role ?? null,
    correlationId: req.requestId ?? null,
  };
}

const suggestQuery = z.object({ address: z.string().trim().min(1).max(200) });

function branchIdOf(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw ApiError.notFound('Không tìm thấy chi nhánh.');
  return id;
}


export function createAdminBranchesRouter(): Router {
  const router = Router();
  router.use('/admin/branches', requireAuth, requirePasswordChanged, requireAdmin);

  // GET /api/admin/branches — every branch (active and inactive) with aliases.
  router.get('/admin/branches', (_req, res, next) => {
    (async () => {
      res.json({ branches: await listBranches() });
    })().catch(next);
  });

  // GET /api/admin/branches/suggest-code?address=… — a proposed stable code.
  // Declared before "/:id" so the literal path is not read as an id.
  router.get('/admin/branches/suggest-code', (req, res, next) => {
    (async () => {
      const { address } = suggestQuery.parse(req.query);
      res.json({ code: suggestBranchCode(address) });
    })().catch(next);
  });

  // GET /api/admin/branches/:id
  router.get('/admin/branches/:id', (req, res, next) => {
    (async () => {
      res.json({ branch: await getBranch(branchIdOf(req.params.id)) });
    })().catch(next);
  });

  // GET /api/admin/branches/:id/history — the branch audit trail.
  router.get('/admin/branches/:id/history', (req, res, next) => {
    (async () => {
      const id = branchIdOf(req.params.id);
      await getBranch(id); // 404s for an unknown branch before exposing history
      res.json({ history: await listBranchHistory(id) });
    })().catch(next);
  });

  // GET /api/admin/branches/:id/receptionists — accounts bound to the branch,
  // so the UI can warn before a deactivation instead of reassigning silently.
  router.get('/admin/branches/:id/receptionists', (req, res, next) => {
    (async () => {
      const id = branchIdOf(req.params.id);
      await getBranch(id);
      res.json({ receptionists: await receptionistsOfBranch(id) });
    })().catch(next);
  });

  // POST /api/admin/branches — create a branch (+ optional platform names).
  router.post('/admin/branches', (req, res, next) => {
    (async () => {
      const input = createBranchSchema.parse(req.body ?? {});
      const branch = await createBranch(input, req.currentUser?.id ?? null);
      res.status(201).json({ branch });
    })().catch(next);
  });

  // PATCH /api/admin/branches/:id — edit number/name/address/breakfast/contact.
  // The stable code is never accepted here: it is immutable after creation.
  router.patch('/admin/branches/:id', (req, res, next) => {
    (async () => {
      const id = branchIdOf(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if ('code' in body) {
        throw ApiError.validation('Mã chi nhánh không thể thay đổi sau khi tạo.');
      }
      const input = updateBranchSchema.parse(body);
      const branch = await updateBranch(id, input, req.currentUser?.id ?? null);
      res.json({ branch });
    })().catch(next);
  });

  /* ---------------------------------------------------------------- */
  /* Platform identities — the ONE current name per (branch, platform) */
  /* ---------------------------------------------------------------- */

  // GET /api/admin/branches/:id/platform-identities — all five rows, including
  // the platforms with no value yet, so the UI renders a complete table.
  router.get('/admin/branches/:id/platform-identities', (req, res, next) => {
    (async () => {
      const id = branchIdOf(req.params.id);
      res.json({ identities: await listIdentities(id) });
    })().catch(next);
  });

  // PUT /api/admin/branches/:id/platform-identities/:platform — create OR
  // replace. One call, one row: there is no "add a second name" operation.
  router.put('/admin/branches/:id/platform-identities/:platform', (req, res, next) => {
    (async () => {
      const id = branchIdOf(req.params.id);
      const platform = parsePlatform(req.params.platform);
      const input = setIdentitySchema.parse(req.body ?? {});
      const identities = await setIdentity(id, platform, input, actorOf(req));
      res.json({ identities });
    })().catch(next);
  });

  // DELETE /api/admin/branches/:id/platform-identities/:platform — remove from
  // active recognition. History is preserved; past bookings are untouched.
  router.delete('/admin/branches/:id/platform-identities/:platform', (req, res, next) => {
    (async () => {
      const id = branchIdOf(req.params.id);
      const platform = parsePlatform(req.params.platform);
      const identities = await deleteIdentity(id, platform, actorOf(req));
      res.json({ identities });
    })().catch(next);
  });

  // POST /api/admin/branches/:id/platform-identities/:platform/confirm —
  // clears the "migration had to choose" flag.
  router.post('/admin/branches/:id/platform-identities/:platform/confirm', (req, res, next) => {
    (async () => {
      const id = branchIdOf(req.params.id);
      const platform = parsePlatform(req.params.platform);
      const identities = await confirmIdentity(id, platform, actorOf(req));
      res.json({ identities });
    })().catch(next);
  });

  // GET /api/admin/branches/:id/identity-history — the immutable trail,
  // deliberately a SEPARATE endpoint so superseded names can never leak into
  // the main current-name list.
  router.get('/admin/branches/:id/identity-history', (req, res, next) => {
    (async () => {
      const id = branchIdOf(req.params.id);
      res.json({ history: await listIdentityHistory(id) });
    })().catch(next);
  });

  /* ---------------------------------------------------------------- */
  /* Legacy alias API — READ-ONLY for one release                      */
  /* ---------------------------------------------------------------- */

  // The alias model allowed several names per (branch, platform) with
  // enable/disable toggles. It is superseded by platform identities. Reads stay
  // available for one release so an operator can still see historical
  // configuration; every mutation is refused with a message that names the
  // replacement rather than failing obscurely.
  const legacyAliasRemoved = (_req: unknown, _res: unknown, next: NextFunction): void => {
    next(
      ApiError.conflict(
        'API tên khách sạn cũ đã ngừng hoạt động. Hãy dùng "Tên hiện tại theo nền tảng" ' +
          '(PUT/DELETE /api/admin/branches/:id/platform-identities/:platform).',
      ),
    );
  };

  router.post('/admin/branches/:id/aliases', legacyAliasRemoved);
  router.patch('/admin/branches/:id/aliases/:aliasId', legacyAliasRemoved);
  router.delete('/admin/branches/:id/aliases/:aliasId', legacyAliasRemoved);

  // POST /api/admin/branches/:id/deactivate — stop new routing, keep all data.
  router.post('/admin/branches/:id/deactivate', (req, res, next) => {
    (async () => {
      const id = branchIdOf(req.params.id);
      const result = await deactivateBranch(id, req.currentUser?.id ?? null);
      res.json(result);
    })().catch(next);
  });

  // POST /api/admin/branches/:id/activate
  router.post('/admin/branches/:id/activate', (req, res, next) => {
    (async () => {
      const id = branchIdOf(req.params.id);
      const branch = await activateBranch(id, req.currentUser?.id ?? null);
      res.json({ branch });
    })().catch(next);
  });

  return router;
}
