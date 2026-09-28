# Graph runtime

`@threadnote/graph` owns graph extraction, indexing, storage, querying, worksets,
maintenance, checkpoints, and graph-sharing protocols. It is a private source
package; its explicit exports preserve module-level dependency tracking.

Application composition supplies two required services from `runtime_ports`:

- `CodeGraphObservability` creates build/workset reporters and receives background
  failures. The CLI application adapts these to its existing consent-aware
  telemetry implementation.
- `CodeGraphProcessActivity` registers builder/waiter activity with the
  application's process diagnostics.

The package does not import application source. CLI output, command orchestration,
and concrete telemetry adapters remain in `src/code_graph`. Checkpoint operations
return results; the application wrappers render them.

Worker invocations use the platform `SystemInfo` service. The application supplies
its development entrypoint through `RuntimeEntrypoint`, and its captured child
process policy through `ChildEnvironmentPolicy`. These dependencies are required;
there is no implicit telemetry policy or source-tree-relative application path.

Language catalog generation still runs from the root release toolchain. Generate
it with `bun scripts/generate-code-graph-language-catalog.ts`; the output belongs
to this package's `src/languages` directory. Native/WASM release payload assembly
continues to be owned by the root build scripts.
