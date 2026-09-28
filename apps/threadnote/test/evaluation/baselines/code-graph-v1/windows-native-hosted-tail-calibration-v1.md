# Hosted Windows native cold-tail calibration

The exact Threadnote 4.6 replacement candidate `afed2ea9a31f99e3d48d20eb2974f0bd9cbba2ad` failed the
native Windows development fixture's two cold wall-time gates in workflow run `33447480677`, artifact
`9778600223`. Its single cold index took 13,508.0338 ms against 10,000 ms, and cold materialization took
7,243.0993 ms against 5,000 ms. The preceding graph-quality workflow step completed successfully. Within the
benchmark artifact, every independently budgeted incremental, query, analysis, RSS, and disk measurement passed.

This was not a graph-runtime regression. The immediate predecessor candidate `4cf4c966cf272a3cb066db29750a415766ec5954`
ran the same graph runtime and harness two hours earlier at 7,211.0128 ms and 1,920.8067 ms. Between those commits,
Threadnote changed Context Brief evidence logic and evaluation policy, but no code graph runtime or benchmark harness.
The failed candidate used less total cold process CPU (4,157 ms versus 4,687 ms); materialization process CPU moved
only from 1,532 ms to 1,625 ms while wall time rose 3.77 times. Its maximum progress-heartbeat gap was 5,251.6984 ms,
snapshot write/checkpoint took 1,239.1353 ms, and the longest activation transaction took 1,023.6224 ms. The evidence
therefore identifies a first-run hosted Windows scheduling/storage tail rather than increased graph computation.

The retained JSON binds the candidate plus 31 prior hosted Windows observations to workflow run, artifact ID, GitHub
archive digest, raw JSON digest, exact commit, environment, seven diagnostic measurements, and structural digests.
It also retains the candidate's actual nine budget-measurement summaries and bounded workflow step outcomes. The
focused test reconstructs that budget projection, reproduces exactly the former two-cold-measurement failure set, and
proves the prospective policy admits the same artifact without inventing replacement values for unchanged guards.
Those prior observations span evolving source commits and are historical context, not a homogeneous statistical sample
or a portable p95. All 31 passed the old 10-second/5-second gates; their maxima were 8,841.8433 ms and 3,296.4708 ms.
The exact predecessor and within-run CPU/wall diagnostics are the causal controls for this calibration.

For `win32` native development evidence only, the prospective hard fuses are:

- cold index: `ceil(13,508.0338 × 1.10 / 1,000) × 1,000 = 15,000 ms`;
- cold materialization: `ceil(7,243.0993 × 1.10 / 1,000) × 1,000 = 8,000 ms`.

These are single-observation scheduler/storage fuses despite the legacy budget-field names; they are not p95 claims or
generic percentage tolerances. Linux and macOS retain 10,000 ms and 5,000 ms. All other platform, vector, scale,
quality, safety, incremental, query, analysis, RSS, and disk gates remain unchanged. One replacement candidate must
pass prospectively. If it exceeds either fuse, stop the release rather than ratcheting again.

The failed artifact also exposed a provenance defect: native matrix jobs did not set a governed runner class or hashed
runner identity, so all 32 retained Windows artifacts said `local-unclassified`. The replacement workflow supplies
both fields, and the privacy-safe normalizer maps the raw hosted Windows label to `github-hosted-windows-x64`.
