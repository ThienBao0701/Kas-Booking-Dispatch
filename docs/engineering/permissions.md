# Permissions — capabilities, branch scope, and how to grow them

Status: groundwork only. There is **no** permission-management screen yet. This note records
where today's rules live, so that a future "Phân quyền" feature extends them instead of
adding a second system alongside.

## Two questions, two modules

| Question | Module | Answer shape |
|---|---|---|
| **Which actions** may this account take? | `server/src/auth/capabilities.ts` | `can(role, 'module.action')` |
| **Which branches** may it act on? | `server/src/auth/branchScope.ts` | `branchScopeOf(actor)` → `'ALL'` or a list of branch ids |

Every protected action needs **both** checks: a capability check (at the route or service level), and a branch-scope check (`assertBranchInScope` or `scopedBranchFilter`) on the specific row.

A capability never widens scope, and scope never grants an action.

## Current capability table

| Capability | Roles | Enforced in |
|---|---|---|
| `reports.delete` | ADMIN, RECEPTION_MANAGER, RECEPTION_GENERAL_MANAGER | `POST /reception/reports/:id/void` (`requireCapability`) + `voidReport` scope |
| `reports.voidOwnBranch` | RECEPTIONIST | same route; existing desk "Hủy", own branch only |
| `reports.deletionHistory` | RECEPTIONIST + the three supervisors | `GET /reception/reports/deleted` (scoped list) |
| `reports.lateEntry` | the three supervisors | `GET /reception/reports/late-entry/sessions`, `POST /reception/reports/late-entry` |
| `reports.editRequiresReason` | RECEPTION_MANAGER, RECEPTION_GENERAL_MANAGER | `updateReport` (a reason is required when the record was created by a receptionist) |
| `technical.dispatchToManager` | TECHNICAL_GENERAL_MANAGER | `dispatchToManager` |
| `technical.assignTechnician` | supervisors, TECHNICAL_MANAGER, TECHNICAL_GENERAL_MANAGER | `requireAssigner` on the `/issues/:id/assign*` routes |
| `technical.dispatchExternal` | TECHNICAL_MANAGER | `dispatchExternal` |
| `technical.completeExternal` | TECHNICAL_MANAGER (the one who hired), TECHNICAL_GENERAL_MANAGER | `completeExternal` |
| `technical.viewContractor` | ADMIN, TECHNICAL_MANAGER, TECHNICAL_GENERAL_MANAGER | `serializeIssue` / `serializeDispatch` (phone, specialty, company masked otherwise) |
| `housekeeping.startCleaning` | HOUSEKEEPING (the assignee) | `startTask` |

Older rules that predate this file are still role lists inside `middleware/auth.ts` (route allow-lists per role) and in individual services. Move them here when they are next touched, not all at once.

## Extension points

1. **Capability map → stored permission table.** `CAPABILITIES` is a `Record<capability, roles[]>`. A future feature can replace the constant with a table (`RolePermission(role, capability)`, or `(department, capability)`) loaded at start-up or per request. `can()` is the only reader. Callers do not change.
2. **Stable names.** Capabilities are `module.action`. They are never renamed or removed once shipped, because stored permission rows would point at them. To retire a capability, make it a no-op instead.
3. **Branch sets.** `BRANCH_SET_ROLES` and `hasBranchSet()` decide which roles carry `UserBranchAssignment` rows. `requireAuth` loads them into `managedBranchIds` on every request, so an Admin's reassignment takes effect on the next request. To add a branch-set role, add it to that list and to the matching `branchScopeOf` case.
4. **Route gate.** `requireCapability(...caps)` admits any one of the listed capabilities. Row-level checks (branch, "only the assignee", "only the manager who hired") stay in the service, where the row is loaded.
5. **Client mirror.** `client/src/auth/capabilities.ts` copies the table **only** to decide which buttons to show. Keep the two in step. The server re-checks every action, so a stale mirror at worst shows a button that answers 403.
6. **Audit.** Write actions record the actor's role from the session (`actorRole`, `voidedByRole`, `enteredByRole`), never from the request body. A permission system must keep that rule.

## Not done (deliberately)

- No UI to edit permissions, and no per-user overrides.
- The default-deny route allow-lists in `middleware/auth.ts` remain the outer gate.
- `/auth/me` does not return capabilities. The client derives them from the role through the mirror.
