# SQLite spool-sort capacity calibration

The persistent code-graph spool sorts one raw surface at a time. Each sort creates an ordered table before dropping its raw table. `symbol_terms` also creates a distinct ordered term table in the same transaction. SQLite may spill `ORDER BY` and `DISTINCT` data to its TEMP filesystem, while the spool's DELETE-mode rollback journal stays beside the spool database.

## Measurement

The calibration used Bun 1.4.2's SQLite on macOS with the spool's 8192-byte page size, `journal_mode=DELETE`, and `temp_store=FILE`. Each fixture ran the production sort statement. `dbstat` measured both ordered B-trees inside the transaction, and the sidecar journal was measured before commit. A separate one-million-row run sampled all open SQLite `etilqs` file sizes with `lsof` during the sort; the peak below is the greatest simultaneous sum observed. The TEMP samples are lower bounds because polling can miss a brief peak.

| Fixture                                     |      Rows | Raw column bytes | Ordered B-tree bytes | Journal before commit | Sampled TEMP peak |
| ------------------------------------------- | --------: | ---------------: | -------------------: | --------------------: | ----------------: |
| Unique short terms, 16-byte symbol IDs      |   100,000 |        3,100,000 |            5,808,128 |                25,112 |                 — |
| Unique 12-byte terms, 240-byte symbol IDs   |   100,000 |       25,500,000 |           28,467,200 |                33,312 |                 — |
| Repeated 120-byte terms, 16-byte symbol IDs |   100,000 |       13,900,000 |           15,065,088 |                25,112 |                 — |
| Unique 120-byte terms, 16-byte symbol IDs   |   100,000 |       13,900,000 |           27,959,296 |                25,112 |                 — |
| Unique 12-byte terms, 240-byte symbol IDs   | 1,000,000 |      255,000,000 |                    — |               149,128 |       276,216,368 |
| Unique 120-byte terms, 16-byte symbol IDs   | 1,000,000 |      139,000,000 |                    — |                     — |       157,144,180 |

Another file-backed fixture sorted all seven surfaces sequentially with 50,000 rows each. Its largest journal was 49,712 bytes, including sorts that reused pages freed by earlier surfaces. The largest ordinary ordered-table ratio was 1.11 times raw column bytes. The `symbol_terms` table is the outlier because it writes the term dictionary too.

## Reservation

For each pending surface, let `P` be the sum of its raw column bytes and `N` its row count. For `symbol_terms`, let `T` be the sum of raw term bytes; this bounds the distinct term payload without running another sort during admission. For other surfaces, `T = 0`.

- Ordered sidecar pages: `max(page size, 256 × max(N), ceil(1.25 × max(P + T)))`.
- TEMP sorter files: `max(page size, 256 × max(N), ceil(1.25 × max(P)))`.
- Durable recovery: `max(configured WAL floor, ceil(ordered sidecar allowance ÷ 4))`.

The 25% payload margins and the existing 256-byte-per-row floor together cover the measured ordered pages; the TEMP margin exceeds the sampled spill ratios. The recovery allowance is much larger than the observed journal but remains separate from TEMP on split filesystems. Existing raw pages are already on disk; the ordered-page allowance reserves their new copy even if SQLite can reuse freed pages. This is an empirical envelope, not a proof for every future SQLite build or data shape. Recalibrate when the spool schema, sort statements, SQLite build, or page size changes.
