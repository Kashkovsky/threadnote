# Workspace-owner pruning work-count contract

PR #686 removes impossible TypeScript reference candidates by routing exact path-owned lookup keys to their eligible
owning workspace scope. Unknown keys retain their existing fallback expansion. This changes the deterministic work
count without changing the fixture's references, resolved graph, or query results.

The hosted Linux [candidate/control/candidate run](https://github.com/Kashkovsky/threadnote/actions/runs/36431417697/job/108958387041)
measured source `7390d08f99cf44268c7e477ffe61b2f570ead760` through merge commit
`ee768fee7eb4437df7661d28e7b6e1df49778660`, against protected-base control
`1ab6edd69dedc341cfaa51eb531ab689996761a2`.

| Measurement                           | Initial candidate | Base control | Candidate retest |
| ------------------------------------- | ----------------: | -----------: | ---------------: |
| Cold reference-candidate rows         |           310,000 |      618,904 |          310,000 |
| Same-overlay reference-candidate rows |           310,000 |      618,904 |          310,000 |
| References examined, each build       |           103,996 |      103,996 |          103,996 |
| References resolved, each build       |           103,996 |      103,996 |          103,996 |
| Lookup-key rows, each build           |           652,441 |      652,441 |          652,441 |
| Cold symbols                          |           111,794 |      111,794 |          111,794 |
| Cold edges                            |           210,903 |      210,903 |          210,903 |
| Cold lexical terms                    |         1,654,329 |    1,654,329 |        1,654,329 |
| Workspace scopes / components         |          25 / 996 |     25 / 996 |         25 / 996 |
| Primary-query structural parity       |                 1 |            1 |                1 |
| Structural graph digest parity        |                 1 |            1 |                1 |

Both candidate observations remove exactly 308,904 redundant candidates. The Linux ratchet therefore changes both
the minimum and maximum to `310000` for `cold-materialized-reference-candidate-rows-n1` and
`same-overlay-reference-materialized-reference-candidate-rows-n1`. Retaining exact two-sided bounds detects future
unexpected fanout growth or missing work. The independent semantic workload and graph parity guards remain unchanged.

This evidence changes only those two deterministic work-count contracts. It does not accept the run: the in-process
MCP impact measurement also failed, at 360 / 149 / 413 ms against a 295 ms ceiling. Timing limits, hard objectives,
paired-run policy, and resource budgets remain unchanged and require separate passing evidence.

The retained JSON payload digests identify the observations independently of artifact packaging:

| Payload                | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| Initial candidate      | `79a9989cbf21998c29850a5e9a1d4d0068da1ca3e97b833fdeeeef245f2aa79d` |
| Protected-base control | `1bbaf40b4b412c851f8276c65a3373adc64a5b9b6a28f7a27c1c7159b8206dbf` |
| Confirmatory candidate | `8c6869a31ec5d80a31b03a4feece306a7035d43d733c2af106b476de6847ffb9` |
