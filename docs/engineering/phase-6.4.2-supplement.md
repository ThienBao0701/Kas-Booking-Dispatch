# Engineering Report Supplement — Phase 6.4.2

**Reference specimen for the phase reporting standard.**

Phase: 6.4.2 — Production PWA install failure
Commits: `4acd783`, `a7bd915`, `de4aa4c`
Original phase report: not modified; this supplements it.

These five sections exist so another engineer can understand what happened, why,
how confident we are and what is still uncertain — **without replaying the
investigation**. That is the test to apply when writing them.

---

## 1. Root Cause Tree

```
SYMPTOM   No "Install Kas App" button. No browser install icon.
          DevTools: "No manifest detected".
             │
             ▼
OBSERVED  GET /manifest.webmanifest → 404      (also /sw.js, /assets/*, /)
          GET /api/health           → 200      ← the app worked perfectly
             │
             ▼
MECHANISM Express never mounted the static handler.
          app.ts:  if (serveClient) mountClient(app)
          With mountClient() skipped there is no express.static AND no SPA
          fallback, so every non-API GET reaches notFoundHandler → 404.
             │
             ▼
CONDITION serveClient === false
          config/env.ts:  serveClient = env.SERVE_CLIENT ?? isProduction
             │
             ├─── SERVE_CLIENT unset ────────────────┐
             │                                       │
             └─── isProduction === false             │
                  NODE_ENV defaults to 'development' │
                       │                             │
                       ▼                             ▼
ROOT CAUSE   .env on the running machine declares neither.

             Two distinct paths produced that same .env:

             (a) FRESH INSTALLS — .env.production.example never set
                 NODE_ENV or SERVE_CLIENT. Both appeared only inside
                 comments, under the line:
                     "NODE_ENV, PORT, SERVE_CLIENT ... are set by
                      compose.production.yml and must NOT be overridden here"
                 True of the Docker path. False of the Windows path, which
                 has no compose file — so nothing set them.
                 → fixed in a7bd915 (template + installer writes absolute paths)

             (b) THE DEV CHECKOUT — C:\Kas-Dev\.env contains a literal
                 NODE_ENV=development. Correct for a checkout; fatal if that
                 same shape reaches a server.
                 → fixed in de4aa4c (service mode now refuses to start)


SECOND, INDEPENDENT CAUSE — found first, fixed first, and NOT the same fault:

          Production hostname was answered by the VITE DEV SERVER.
             │
             ▼
          Tunnel → :5173. Vite accepted the host because vite.config.ts had
          allowedHosts: ['kasbookingapp.com'], and Vite's own /api proxy
          forwarded to the real backend — so the app worked while serving
          /src/main.tsx and @vite/client, and never a built manifest.
             │
             ▼
          → fixed in 4acd783 (hostname removed; the test that PINNED it inverted)
```

**Why the tree has two roots.** Both were live at the same time and either alone
reproduces the symptom. Fixing one would have left the other, which is exactly
what happened between `4acd783` and the next round of evidence.

---

## 2. Investigation Timeline

| # | Evidence | Source | What it ruled in / out |
| --- | --- | --- | --- |
| 1 | `/manifest.webmanifest` and `/manifest.json` 404 on production; "No manifest detected" | User | Symptom established as production fact, not hypothesis |
| 2 | `client/dist/manifest.webmanifest` present, 2,498 bytes; `sw.js`, `workbox-*.js` present | Local build | **Ruled out** build / VitePWA config |
| 3 | Built `index.html` contains `<link rel="manifest" href="/manifest.webmanifest">` | Local | **Ruled out** missing link tag |
| 4 | `Package-Kas.ps1` copies `client\dist` wholesale; 6.4 payload test asserts it | Local | **Ruled out** packaging |
| 5 | Local server, `SERVE_CLIENT=true` → 200 `application/manifest+json` | Experiment | **Ruled out** static middleware and MIME |
| 6 | `/nonexistent-page` → 200 HTML (SPA fallback) | Experiment | **Key deduction:** this app *cannot* 404 a GET outside `/api`. A real 404 means something else answered. |
| 7 | — | — | **STOPPED.** Reported; asked for three production facts rather than guess. |
| 8 | Production `/nonexistent-page` → 200 HTML containing `/@vite/client` and `/src/main.tsx` | User | Production was serving the **Vite dev server** |
| 9 | `vite.config.ts`: `allowedHosts: ['kasbookingapp.com']` | Local | The enabler. Fixed → `4acd783` |
| 10 | `viteConfig.test.ts` asserted that hostname **was** allow-listed | Test run failure | A test was **pinning the defect** |
| 11 | `localhost:3001` manifest + sw.js 404; files exist in `C:\Kas\client\dist`; `Kas.cmd` prints `NODE_ENV = development` | User | **Ruled out** Cloudflare entirely. Backend itself not serving. |
| 12 | `.env.production.example` mentions `NODE_ENV` only inside comments | Local | Root cause (a) for fresh installs |
| 13 | Starting with `NODE_ENV=production` **refused to boot**: absolute paths + non-placeholder secrets required | Experiment | Template fix alone would have made fresh installs **dead**, not merely uninstallable → installer now writes absolute paths |
| 14 | 3194 (`development`) → 404 · 3192 (`production`) → 200 `application/manifest+json` | Experiment | Mechanism proven in both directions, same build, same port |
| 15 | User: fix still not active; `Kas.cmd` still prints development | User | The fix landed in a file the failing machine never reads |
| 16 | `Kas.cmd` sets only `EXITCODE`; runner loads `.env`; `C:\Kas-Dev\.env` literally contains `NODE_ENV=development` | Local audit | Root cause (b): checkout config, not launcher behaviour |
| 17 | `KasService.cmd` in this checkout → refuses, exit 1, names both lines | Experiment | Guard verified → `de4aa4c` |

---

## 3. Confidence Assessment

| Dimension | Confidence | Basis |
| --- | --- | --- |
| **Root Cause** | **High** | Reproduced in both directions on the same build and port: `NODE_ENV=development` → 404, `NODE_ENV=production` + `SERVE_CLIENT=true` → 200 `application/manifest+json`. The code path (`serveClient` → `mountClient` → `express.static`) was read, not inferred. |
| **Fix** | **High for the repository, unverified for the machine.** | Template, installer and runtime guard each verified locally, including the refusal path (exit 1 with the correct message). No change has been applied to the live host. |
| **Regression** | **High** | 1901 server + 467 client tests green; typecheck, lint, build, `git diff --check` clean. Two behaviour changes are deliberate and narrow: the dev server now rejects the production hostname, and `KasService.cmd` refuses a misconfigured start. |
| **Production Verification** | **None.** | The live host was never reachable from this worktree, and `C:\Kas` is off-limits by standing instruction. No DevTools check — manifest detected, SW registered, installable, install icon, shortcuts, standalone launch — has been performed by me. Every production claim in the report is inference from local reproduction. |

Grading Production Verification as *none* rather than *low* is deliberate: "low"
would imply some evidence exists. There is none.

---

## 4. Remaining Risks

| # | Risk | Severity | Why it survives |
| --- | --- | --- | --- |
| R1 | **The live machine is still misconfigured.** Its `.env` predates the fix, and upgrades deliberately never overwrite it. Next reboot still serves 404s. | High | By design — that file holds the database password. Requires a human edit. |
| R2 | **Deploying this build could take the site fully down.** If the tunnel still points at `:5173`, removing `allowedHosts` turns "works but uninstallable" into `Blocked request. This host is not allowed`. | **High** | The fix is correct; the *sequencing* is dangerous. Repoint the tunnel to `:3001` **before** deploying, not after. |
| R3 | **Adding `NODE_ENV=production` may stop the server booting.** Production also demands `SESSION_COOKIE_SECURE=true`, an `https://` `APP_ORIGIN`, non-placeholder secrets and absolute paths. | Medium | Validator behaving correctly, but the failure lands at edit time. Do it outside business hours and have `Kas.cmd --diagnose` ready. |
| R4 | **A third cause may exist.** Two independent causes were found; nothing proves there is not a third between the tunnel and Express. | Low | Cannot be excluded without access to the live host. |
| R5 | **`--diagnose` probes `localhost`, not the public origin.** A tunnel repointed at the wrong port still passes every check on the server. | Medium | The detector answers "is this machine serving the build", not "is the public URL serving it". |
| R6 | **`KasService.cmd`'s success path was never observed end to end.** Two launch attempts failed on harness error and wrote no logs. | Low | The refusal path was observed; the serving behaviour was verified three times by running the built server directly. |

---

## 5. Lessons Learned

**1. Know what your own system cannot produce.** The decisive move was not
finding the manifest — it was realising the SPA fallback means this app *cannot*
return 404 for a GET outside `/api`. That converted an open-ended search into a
bisection: a real 404 proves something else answered. **Ask early: what
responses is my code incapable of producing?**

**2. A test can pin a defect.** `viteConfig.test.ts` asserted that the
production hostname *was* allow-listed on the dev server — the exact line that
caused the outage. It went green for months. **When a test fails during a fix,
check whether the test or the behaviour is wrong; and when writing one, ask what
it would do if this behaviour became harmful.**

**3. "It works" hides configuration faults better than crashes do.** Both root
causes produced a fully functional application. Logins, dispatch, bookings, and
health 200 throughout. The only casualty was a missing button, three layers from
its cause. **A fault that degrades a feature nobody exercises daily can survive
an entire deployment. Health checks that only prove liveness will not find it.**

**4. Verify the fix's delivery path, not just its content.** `a7bd915` was
correct and had zero effect on the machine under test, because it changed a
template the installer copies into *fresh* installs while the failing machine
had an existing `.env`. **Before claiming a fix, answer: which file does the
failing machine actually read, and does my change reach it?**

**5. Test the fix's own failure mode before shipping.** Declaring
`NODE_ENV=production` in the template would have made every fresh install refuse
to boot — turning "uninstallable" into "dead". Found only by attempting a real
production start. **Run the new happy path end to end; a fix that converts a
subtle fault into an outage is worse than the fault.**

**6. Configuration defaults rot when a deployment topology changes.** The
template omitted runtime variables because "compose sets them". Correct for
Docker, silently wrong once Windows became the supported path. **When a
deployment target changes, audit every "something else sets this" assumption —
those comments are load-bearing and invisible.**

**7. Make the decisive setting visible at the moment of action.** The fix was
not only correcting `.env`; it was printing `Phục vụ giao diện: KHÔNG` at
startup and refusing in service mode. **A value the whole deployment depends on
should be stated where the operator is already looking, and a production entry
point should refuse a configuration it cannot serve, not start half-working.**

**8. Stop and ask when the evidence runs out.** The first audit ended without a
code change, because everything observable was correct and the next step needed
facts only the user could obtain. Guessing would have produced a plausible fix
in the wrong layer. **A phase that ends in "here is what I need to know" is a
successful phase.**

### Tooling lessons (PowerShell 5.1, this project)

These cost real time across 6.3a–6.4.2 and recur:

- **`2>$null` / `2>&1` on a native command** wraps stderr in an `ErrorRecord`
  and can flip `$LASTEXITCODE` or abort under `$ErrorActionPreference = 'Stop'`.
  It broke an uninstall, a packaging run, and produced three false "test
  failures". **Check the exit code; never redirect a native command's stderr.**
- **Piping a native command** through `Select-Object` replaces `$LASTEXITCODE`
  with the pipeline's result — it silently discarded a valid git commit hash.
- **`Start-Process` does not inherit PowerShell's location.** Pass
  `-WorkingDirectory` explicitly, or the target `.cmd` is never found.
- **`iexpress.exe` is a GUI app** — `&` returns before it writes anything. Use
  `Start-Process -Wait`.
