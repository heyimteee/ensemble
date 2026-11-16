# Package rollback

Ticket #273. Use this when a release upgrade must be reversed: the previous
package version is reinstalled, and durable state is restored only if the
older release cannot read what the newer one wrote.

## Decision

1. **Package-only rollback** is enough when the newer release did not change
   durable state or when its changes are additive. Ensemble's `v2/` rows are
   additive within the 0.x line: unknown fields are ignored, and the store has
   no separate schema version. Reinstall the previous version and restart.
2. **State rollback** is required when a newer release wrote rows the older
   release rejects, or when the state itself is wrong. Restore the
   pre-upgrade backup first, then reinstall the previous version. Restoring
   first means the older code never starts against newer rows.

Keep the pre-upgrade backup and the rollback slot until the rolled-back
workspace has run successfully.

## Package-only rollback

```sh
opencode plugin list                     # record the current entry
opencode plugin add @heyimteee/ensemble@<previous-version>
opencode plugin list                     # confirm the exact pinned version
```

Restart OpenCode. Confirm `npm run doctor -- "$PWD"` reports zero mismatches,
then send one group message. If the older release reports an unknown state
shape, stop and use the state rollback.

## State rollback

```sh
npm run backup -- status "$PWD"                       # automatic pre-restore slot
npm run backup -- rollback --confirm ROLLBACK "$PWD"  # apply it
# or restore the file taken before the upgrade:
npm run backup -- restore --in ./ensemble-backup.json --confirm RESTORE "$PWD"
```

Restart OpenCode afterwards. The restore is refused while work is running,
writes one rollback slot of its own, and returns `restore_failed_rolled_back`
if it had to keep the previous state. A second failure leaves the slot intact;
fix the host and retry `rollback`.

Do not restore a backup produced by a newer `formatVersion`; the release
rejects it with `unsupported_backup`. Keep the newer release installed until a
release that reads it is available.

## Rehearsal

The failure rehearsal is part of `npm run verify` and proves that a failed
upgrade leaves the previous state recoverable:

```sh
node --test --experimental-strip-types \
  --test-name-pattern="ticket273" \
  src/v2/backup.test.ts src/v2/service.test.ts
```

Expected evidence:

| Case | Result |
|---|---|
| Export then restore | Same entities, meta settings, and workspace config; version advances |
| Restore with an injected write failure | `restore_failed_rolled_back`; previous rows and config text are back |
| Restore with a permanent write failure | `restore_failed`; a complete pre-restore document remains at `v2/backup/rollback` |
| Apply that slot in a clean store | Previous state is reproduced |
| Doctor against restored state | Zero mismatches |
| Busy service | `busy`; nothing is written |

A real package downgrade rehearsal (install `0.1.0`, then reinstall
`0.1.0-rc.1`) is blocked until the candidate is published and a previous
installable version exists. Record it in the release sign-off (#278) rather
than claiming it here. The blocked check is listed in
[the ticket #273 record](../verification/2026-11-16-ticket-273.md).
