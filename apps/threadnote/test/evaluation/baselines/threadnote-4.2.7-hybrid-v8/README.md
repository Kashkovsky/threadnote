# Threadnote 4.2.7 hybrid-v8 recall quality baseline

`recall-v2-lexical.json` is the active reviewed explicit-project lexical quality gate. It was captured from clean
commit `6f77ff434b948390f3e1d0afaf7e1e00d359fa89` with package version 4.2.7 and ranker `hybrid-v8`.

The artifact records the exact identities of 99 reviewed lexical-only contract defects, down from 193 in the historical
4.2.7 `hybrid-v3` artifact. The removed identities reflect product behavior: explicit project and authority eligibility
are applied before bounded lexical retrieval, and exact source identifiers receive confidence without accepting
generated query variants. Forbidden-hit rate is zero, Recall@1 is 0.8844, MRR is 0.8978, and all 25 true no-answer
controls remain correct.

`hybrid-v8` additionally handles explicit recency intent from the original query. The lexical index stores canonical
record timestamps and admits a bounded set of the newest topically matching candidates before normal ranking, preventing
current handoffs from being starved by more than 100 older matches. The 250-query fixture aggregates remain unchanged
from `hybrid-v7`; the production behavior is covered by a real SQLite-store regression instead of adding a synthetic
waiver or deleting failure identities.

The remaining identities are concentrated in queries whose contract requires a semantic stage or reason. They stay
visible rather than being removed synthetically from the lexical fixture. The production BGE model evaluation is the
complementary end-to-end semantic-quality check. Omitted-project global retrieval is intentionally diagnosed with
`--no-baseline --global-eligibility` because it has a broader eligibility contract than this explicit-project gate.

The earlier `../threadnote-4.2.7/recall-v2-lexical.json` artifact remains immutable historical quality evidence, and
its colocated Apple M1 Max `hybrid-v3` artifacts remain the current same-host rank-performance reference.
