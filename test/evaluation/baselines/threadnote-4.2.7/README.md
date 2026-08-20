# Threadnote 4.2.7 recall quality baseline

`recall-v2-lexical.json` is the active reviewed lexical quality baseline. It was captured before ranker changes from
clean commit `297cdb92bd164ed2ea58dd6c366c60c67aba97cf` with package version 4.2.7 and ranker `hybrid-v3`.
The legacy `openVikingVersion` compatibility field is `not-applicable` because this pipeline does not invoke
OpenViking.

The artifact records the exact identities of 193 reviewed contract defects. They remain visible improvement work: CI
allows fixes but rejects any newly introduced failure identity or count increase, and independently gates aggregate,
category, and safety non-inferiority. A strict run without a baseline requires zero defects.

This directory contains no current performance baseline. The checked-in Threadnote 3.0.3 and 4.0 performance artifacts
remain historical, hardware-bound observations and were not regenerated for this transition.
