# Context Brief RSS observer capacity calibration v1

The first exact 100-sample prospective run (`33466815457`, job `99728282139`) executed the reviewed three profiles and reached the RSS protocol's old 256-observation ceiling before a scale artifact could be written. Observation 257 used request sequence 513, the child rejected it and exited, and the parent continued polling stale acknowledgement 512 until its 30-second timeout. The retained log digest and built-target digest bind this diagnosis; `artifactProduced: false` prevents the run from being mistaken for budget evidence.

The corrected bound is derived from the release contract itself: 3 profiles × 100 measured samples = 300 observations, with stop sequence 601. Argument parsing rejects any larger profile/sample schedule before expensive setup. A child exit is detected during acknowledgement polling and its bounded stderr is propagated, so a protocol failure cannot be masked as a generic timeout.

The correction changes observer capacity and error visibility only. It does not weaken RSS, sample-gap, latency, work, lease, session, or correctness budgets. A fresh exact candidate must still produce and pass the complete 100-sample artifact prospectively.
