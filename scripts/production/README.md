# `scripts/production/` — which of these is current

**The supported deployment is Windows + PostgreSQL.** Everything for it lives in
[`windows/`](windows/).

| Use | Command |
| --- | --- |
| Install / upgrade | `windows\Install-Kas.cmd` |
| Start (operator) | `Kas.cmd` |
| Start at boot | Scheduled Task `Kas` → `KasService.cmd` |
| Stop | `KasService.cmd stop` |
| Backup | `KasBackup.cmd`, or nightly Scheduled Task `Kas Backup` |
| Restore | `npm run prod:restore -- --backup=<dir> --safe` |
| Diagnose | `Kas.cmd --diagnose` |
| Uninstall | `windows\Uninstall-Kas.ps1` |

## The `.sh` scripts are archived

`backup.sh`, `deploy.sh`, `health-check.sh`, `restore.sh`, `rollback.sh` and
`update.sh` belong to the **Docker + Ubuntu + SQLite pilot** (milestone D.0).
That topology is no longer used and these scripts are **not maintained**.

They are kept, rather than deleted, because they are the procedure referenced by
[`docs/archive/production-deployment.md`](../../docs/archive/production-deployment.md)
— which in turn is what the current backup tool points an operator at when it
refuses a SQLite-era (`formatVersion: 1`) archive. Deleting them would leave
that error message pointing at nothing.

**Do not run them against the Windows deployment.** They assume Docker
Compose, a Linux filesystem layout and a SQLite database file, none of which
exist here.
