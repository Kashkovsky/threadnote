# SQLite writer tuning experiment

This experiment measures code-graph materialization candidates without changing the production writer defaults.
It reuses the full code-graph benchmark: cold build, one-file incremental overlay, independent full rebuild of that
overlay, query controls, structural digest parity, process-tree telemetry, SQLite file peaks, and progress liveness.

Select one candidate with `--sqlite-writer-profile`:

| Profile                            | Isolated variable                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `current`                          | Current cache/checkpoint settings; does not override the runtime synchronous mode                               |
| `cache-8m`                         | 8 MiB writer cache                                                                                              |
| `cache-32m`                        | 32 MiB writer cache                                                                                             |
| `cache-64m`                        | 64 MiB writer cache                                                                                             |
| `cache-128m`                       | 128 MiB writer cache                                                                                            |
| `cache-256m`                       | 256 MiB writer cache                                                                                            |
| `mmap-256m`                        | 256 MiB main-database mmap window                                                                               |
| `wal-checkpoint-8192`              | 8,192-page passive auto-checkpoint cadence                                                                      |
| `building-normal-full-publication` | `synchronous=NORMAL` for reconstructible full-build rows, restored to `FULL` before the ready-state transaction |
| `combined-candidate`               | Combination of the individually measured candidates; evaluate only after isolated variables win                 |

The benchmark reads every effective PRAGMA back from SQLite. It fails instead of publishing an artifact if cache,
mmap, checkpoint cadence, WAL mode, or NORMAL-to-FULL publication ordering differs from the requested profile.
The effective settings and their benchmark phase are retained in privacy-safe artifact metadata.
Do not infer the control's synchronous mode from SQLite defaults: Bun's compiled default is part of the measured
runtime and may differ by release. `building-normal-full-publication` enforces the publication boundary even when
the control already reads back as NORMAL.

## Controlled run

Run variants only in an isolated window on the same clean Threadnote commit, pinned public-repository commit, runner,
disk, and query controls. Give every run fresh primary and reference homes. For example, add this flag to the existing
external-repository benchmark command:

```text
--sqlite-writer-profile current
```

Repeat with one candidate at a time. Alternate control and candidate order to reduce thermal and filesystem-cache
bias. Treat each artifact's phase timings as one observation; repeat the control and any apparent winner at least
three times before selecting a default.

Every isolated profile retains the production 64 KiB writer cache and 1,000-page checkpoint baseline except for the
single setting named by that profile. The cache profiles change only cache size; the combined profile is intentionally
multi-variable. Verify this in each artifact's effective PRAGMA evidence before comparing timings.

Compare at least:

- cold and independent-full materialization wall and process CPU;
- per-stage materialization time for validation, symbols, lookups, terms, edges, references, candidates, analysis,
  resumable receipt, and commit;
- physical/logical I/O from the external sampler, main database/WAL/SHM/TEMP peaks, and peak process-tree RSS;
- longest transaction and maximum heartbeat gap;
- cold, incremental, and independent-full query controls plus structural graph digest parity;
- interruption/resume behavior and the last ready snapshot after an injected publication failure.

Reject a candidate if it changes the graph digest or query controls, weakens the ready-state publication boundary,
opens repository-sized TEMP storage, materially increases peak RSS/disk, or worsens liveness. Do not select a
production default from a small synthetic fixture or a host-contended run.

SQLite documents that WAL transactions at `synchronous=NORMAL` remain consistent but may lose recent commits after
power loss, while `FULL` adds a WAL sync after each commit. It also documents that auto-checkpoints are passive and
default to 1,000 pages. The NORMAL candidate is therefore limited to unpublished, fingerprinted, reconstructible
rows and switches back to FULL before the transaction that makes a snapshot visible.

- <https://www.sqlite.org/pragma.html#pragma_synchronous>
- <https://www.sqlite.org/pragma.html#pragma_wal_autocheckpoint>
- <https://www.sqlite.org/wal.html#performance_considerations>
