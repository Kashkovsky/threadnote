import type {CliCommandReference, DocsArticle} from './docsTypes.js';

export const optionalAnonymousTelemetryCliCommand: CliCommandReference = {
  command: 'telemetry',
  summary: 'Preview, explicitly enable, inspect, or revoke anonymous CLI and MCP operational telemetry.',
  examples: [
    'threadnote telemetry status',
    'threadnote telemetry enable',
    'threadnote telemetry enable --apply',
    'threadnote telemetry disable --apply',
  ],
};

export const optionalAnonymousTelemetryDocsArticle: DocsArticle = {
  id: 'optional-anonymous-telemetry',
  title: 'Optional anonymous telemetry',
  summary: 'Explicitly opt in to allowlisted CLI and MCP diagnostics, or keep the default off.',
  keywords: ['anonymous telemetry', 'OpenTelemetry', 'OTLP', 'privacy', 'diagnostics'],
  body: [
    {
      type: 'code',
      language: 'sh',
      code: `threadnote telemetry status
threadnote telemetry enable
# Review the preview, then opt in only if you agree:
threadnote telemetry enable --apply
# Revoke persisted consent:
threadnote telemetry disable --apply`,
    },
    {
      type: 'paragraph',
      text: 'Telemetry is disabled by default. Applied consent covers allowlisted CLI and MCP operation names, outcomes, durations, coarse memory and progress buckets, and safe typed failure classes. An automatic-update worker completion adds one closed result (busy, current, disabled, failed, or updated); updated results add a repair-required boolean. A successful graph build additionally adds path-free diagnostics: clean/dirty kind; closed materialization, fallback, closure, and efficiency classes; changed, deleted, delta, extracted, reused, staged, and total file-count buckets; cached, changed, and final fact-byte buckets; and rewrite/replay-amplification buckets. MCP graph inspections can additionally add only closed request kind, local/workset scope, snapshot selection/freshness, phase/stage/subphase, and published file/symbol/edge-count buckets. A failed graph build adds only bounded outcome/failure type to this lifecycle surface, while an interrupted graph build adds only outcome/duration; neither adds graph classifications or buckets. Telemetry also covers app and runtime versions, random session and invocation identifiers, and the timestamps and transport IDs required by OTLP. It never includes arguments, environment values, paths, repository or commit identity, prompts or memory content, queries or results, MCP payloads, exception messages, stacks, account identifiers, or a persistent installation identifier.',
    },
    {
      type: 'paragraph',
      text: 'Consent is versioned separately from the configuration format. If the allowlist gains a material category, earlier consent fails closed and telemetry remains off until the current preview is reviewed and explicitly applied again; Threadnote never migrates an older opt-in silently.',
    },
    {
      type: 'paragraph',
      text: 'The default first-party endpoint validates the complete versioned envelope before forwarding traces to Grafana Cloud EU. Accepted traces use the stack’s shortest current retention: 14-day trace retention on the free plan. Fly.io and Grafana necessarily process source IP addresses while transporting HTTPS requests, but Threadnote neither writes an IP into a trace nor emits application access logs.',
    },
    {
      type: 'list',
      items: [
        'A random MCP session identifier lasts for one broker lifetime; a standalone CLI invocation gets a fresh identifier.',
        'DO_NOT_TRACK=1 or THREADNOTE_TELEMETRY=0 disables sending without removing persisted consent.',
        'Changing, enabling, or re-enabling telemetry requires restarting already-connected MCP clients; CLI changes apply on the next invocation.',
        'Exporter, network, shutdown, and telemetry-config failures are best-effort and cannot change the application result.',
      ],
    },
    {
      type: 'note',
      text: 'Run threadnote telemetry enable without --apply to review the exact current data and destination contract without writing configuration or making a request.',
    },
  ],
};
