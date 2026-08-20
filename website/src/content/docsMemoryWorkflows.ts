import type {DocsSection} from './docsTypes.js';

export const memoryWorkflowsDocsSection: DocsSection = {
  id: 'memory-workflows',
  title: 'Memory workflows',
  description: 'Capture durable knowledge, continue across agents, seed trusted guidance, and keep memory healthy.',
  articles: [
    {
      id: 'remember-and-handoff',
      title: 'Remember and hand off',
      summary: 'Separate reusable truth from transient work state.',
      body: [
        {
          type: 'heading',
          text: 'Durable feature knowledge',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote remember \\
  --kind durable \\
  --project payments \\
  --topic idempotency-contract \\
  --source-agent-client codex \\
  --text "Retries reuse the original idempotency key. Evidence: docs/payments.md."`,
        },
        {
          type: 'heading',
          text: 'Current work state',
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote handoff \\
  --project payments \\
  --topic retry-rollout \\
  --task "Roll out idempotent retries" \\
  --tests "bun test payments" \\
  --blockers "Sandbox fixture is unavailable" \\
  --next-step "Re-run integration tests"`,
        },
        {
          type: 'paragraph',
          text: 'Store normal feature knowledge and handoffs directly at meaningful closeout. A later agent can recall the stable decision and the active execution state independently.',
        },
      ],
    },
    {
      id: 'candidate-review',
      title: 'Additional candidate review',
      summary: 'Let the agent propose extra memories without silently turning a session summary into truth.',
      body: [
        {
          type: 'paragraph',
          text: 'After normal durable and handoff writes, review_session_context may form up to three extra decision, invariant, preference, or handoff candidates. It compares existing active project/topic memories and persists only a pending review with audit history.',
        },
        {
          type: 'list',
          items: [
            'Approve may create or replace active memory only with explicit user approval.',
            'Reject and defer never write active memory.',
            'Revision and content checks prevent a stale review from overwriting newer knowledge.',
            'Evidence is required for material candidate content.',
          ],
        },
        {
          type: 'note',
          text: 'Use candidate review for additional session-extracted suggestions, not as a substitute for the normal handoff and durable writes an agent already knows are needed.',
        },
      ],
    },
    {
      id: 'seeding',
      title: 'Seed repository guidance',
      summary: 'Import a curated allowlist of agent instructions and docs without indexing an entire repository.',
      body: [
        {
          type: 'code',
          language: 'sh',
          code: `threadnote init-manifest --repo "$PWD"
threadnote seed --dry-run
threadnote seed`,
        },
        {
          type: 'paragraph',
          text: 'The per-developer seed manifest maps projects to canonical resource URIs and explicit patterns. Defaults focus on AGENTS.md, CLAUDE.md, README, contribution guidance, selected .github/.claude files, and docs Markdown.',
        },
        {
          type: 'paragraph',
          text: 'Ignore rules apply during traversal. Hidden directories are skipped unless an explicit manifest pattern names one, and dependency/build caches such as node_modules and .nx are excluded. Per-project traversal and candidate limits stop pathological trees; one failed project does not prevent later projects from seeding.',
        },
        {
          type: 'warning',
          text: 'Seeded repository text remains secondary to the current checked-in file. Do not use seeding as an automatic whole-repository ingestion mechanism.',
        },
      ],
    },
    {
      id: 'worksets',
      title: 'Cross-repository worksets',
      summary:
        'Prepare one published ready-snapshot catalog, retrieve globally ranked evidence, and trace explicit contracts across related repositories.',
      keywords: [
        'cross repository graph search',
        'workset graph query',
        'multi repository search',
        'workset prepare status',
        'workset search 2.0',
        'context brief',
        'graph continuation cursor',
        'cross repository path impact topology',
        'ready snapshots',
        'repository provenance',
      ],
      body: [
        {
          type: 'paragraph',
          text: 'A workset is a named list of projects from ~/.threadnote/seed-manifest.yaml. Recall searches durable memories and seeded guidance across that scope. Workset Search 2.0 searches current source differently: it routes normal task text through one disposable catalog derived from exact per-repository ready snapshots, globally ranks candidates, and opens only the strongest repository graphs for bounded deep reads.',
        },
        {
          type: 'note',
          text: 'This is an agent-oriented evidence interface, not a query language. Give Threadnote the task, scope, and budget in plain text. Threadnote keeps the routing plan internal and returns compact evidence with stable handles for drill-down.',
        },
        {
          type: 'heading',
          text: '1. Define and verify the workset',
        },
        {
          type: 'code',
          language: 'yaml',
          code: `version: 1
projects:
  - name: checkout-api
    path: ~/src/checkout-api
    uri: threadnote://resources/repos/checkout-api
    seed: []
  - name: checkout-web
    path: ~/src/checkout-web
    uri: threadnote://resources/repos/checkout-web
    seed: []
worksets:
  - name: checkout
    description: Checkout API and client
    projects: [checkout-api, checkout-web]`,
        },
        {
          type: 'code',
          language: 'sh',
          code: `threadnote workset list
threadnote workset show checkout`,
        },
        {
          type: 'paragraph',
          text: 'Each workset member names a top-level project. Matching is case-insensitive. Unknown project names remain explicit unresolved members, so use workset show before preparation and treat its resolved membership as the intended scope.',
        },
        {
          type: 'heading',
          text: '2. Check coverage, then prepare explicitly',
        },
        {
          type: 'code',
          language: 'sh',
          code: `# Read-only: compare the manifest, current ready snapshots, catalog generation,
# and cross-repository bridge receipt. This never starts indexing.
threadnote workset status checkout
threadnote workset status checkout --json

# Explicit cold-build and refresh path. Default concurrency is 2; maximum is 8.
threadnote workset prepare checkout --concurrency 4
threadnote workset prepare checkout --json`,
        },
        {
          type: 'warning',
          text: 'A query never fans out cold builds. workset prepare is the only workset operation that indexes or refreshes repositories. Run it after adding a member, changing a member path, or when status reports a missing, stale, deferred, failed, or uncatalogued member.',
        },
        {
          type: 'paragraph',
          text: 'Preparation builds or refreshes configured repositories, streams routing projections into the home-global catalog, resolves supported cross-repository monikers, and atomically publishes one cgwg_ generation. The CLI reports the active member, repository-index phase and counters, projection/catalog/bridge/publication phases, elapsed time, and completed-member count while work continues. A retryable storage or checkout race receives one bounded retry. It may publish a non-empty ready subset while retaining missing, failed, or excluded member receipts; incomplete coverage is called out separately from publication success. If no member can be published, the prior ready generation remains the last good state.',
        },
        {
          type: 'paragraph',
          text: 'The JSON prepare command emits bounded code-graph-workset-progress records on stderr and keeps the final receipt on stdout. The receipt reports complete/incomplete coverage, each ready/missing/failed/excluded member, typed failure code, retryability and recovery guidance, projection symbol counts, the published generation, moniker and bridge counts, resolver version, rejection count, and any unavailable repositories. JSON status separates catalog missing/ready/stale from member current/deferred/excluded/failed/missing/stale/uncatalogued states and includes the published bridge digest/count plus complete, partial, or failed bridge coverage diagnostics. Uncatalogued means a ready repository snapshot is absent from the published Workset generation, not that its repository indexing necessarily failed.',
        },
        {
          type: 'paragraph',
          text: 'The catalog is disposable derived data; each repository’s snapshot database remains authoritative and isolated. A published generation binds the workset manifest digest plus each member’s repository, checkout, worktree, commit, snapshot, and projection identities. The generation associates a separately digested bridge-set receipt keyed to that generation; the bridge digest is not folded into the generation digest. Deleting or rebuilding the catalog never turns it into a second copy of repository source.',
        },
        {
          type: 'heading',
          text: '3. Ask a bounded source question',
        },
        {
          type: 'code',
          language: 'sh',
          code: `# Historical decisions, handoffs, and seeded guidance across the workset.
threadnote recall --query "payment retry contract" --workset checkout

# Current-source evidence, globally ranked across the published generation.
threadnote graph query \\
  --workset checkout \\
  --query "payment retry contract" \\
  --budget-tokens 1250 \\
  --node-limit 20 \\
  --edge-limit 40

# JSON includes the V2 evidence cards, coverage receipt, generation, and cursor.
threadnote graph query \\
  --workset checkout \\
  --query "payment retry contract" \\
  --budget-tokens 1250 \\
  --json`,
        },
        {
          type: 'paragraph',
          text: 'The query is NFKC-normalized and bounded as task text; no public DSL is parsed. Exact symbol, qualified name, package, path, path suffix, export, and lexical evidence contribute to deterministic global ranking. --package narrows deep reads to one exact package. --node-limit, --edge-limit, --depth, and optional provenance flags bound selected repository reads; they do not reserve one equal result slot per repository.',
        },
        {
          type: 'paragraph',
          text: 'Each selected repository query defaults to depth 2, 20 nodes, and 40 relationships. CLI and MCP accept depth 0–8, nodeLimit or --node-limit 1–200, and edgeLimit or --edge-limit 1–500. These local graph limits are separate from the 1,250-token response projection and global routing bounds.',
        },
        {
          type: 'note',
          text: 'CLI text output is a terse card-count, coverage, and continuation receipt for agent logs. Use --json to read evidence cards. MCP returns that terse receipt in content and the bounded V2 projection in structuredContent.',
        },
        {
          type: 'note',
          text: 'Heuristic relationships and model associations remain opt-in supporting evidence. They can help a local query, but they never become authoritative cross-repository bridges.',
        },
        {
          type: 'heading',
          text: '4. Query through MCP',
        },
        {
          type: 'code',
          language: 'json',
          code: `{
  "operation": "query",
  "callerCwd": "/workspace/checkout-api",
  "workset": "checkout",
  "query": "payment retry contract",
  "budgetTokens": 1250,
  "nodeLimit": 20,
  "edgeLimit": 40
}`,
        },
        {
          type: 'paragraph',
          text: 'Pass this payload to inspect_code_graph. callerCwd remains a required absolute MCP transport field, but in a named workset operation it is validated without selecting or narrowing a member; the seed manifest supplies every member path. callerCwd selects a repository/worktree only for repository-scoped operations. The response includes terse text for the model and the same bounded structured V2 projection. query, path, impact, and topology accept a named workset; analyze_code_graph remains a one-repository architecture analyzer.',
        },
        {
          type: 'heading',
          text: '5. Read evidence, coverage, and trust before drilling down',
        },
        {
          type: 'table',
          headers: ['Contract', 'Behavior'],
          rows: [
            [
              'Global routing',
              'There is no eight-repository admission cap or manifest-order answer prefix. Indexed candidate reads cover the complete published generation and return globally ranked repository and symbol candidates.',
            ],
            [
              'One-hop contract neighbors',
              'Before deep reads, Threadnote reads incoming and outgoing bridge adjacency for the strongest 16 catalog-routed repositories. Each seed direction is capped at 64 bridges, at most four seed repositories are processed concurrently with both directions read concurrently, and no generation-wide bridge scan occurs; the expansion therefore retains at most 2,048 unique bridge records. Exact one-hop neighbors enter the deterministic candidate sequence without changing the original catalog symbol ranks. Incomplete bridge-set coverage withholds expansion; a per-seed edge cap returns the bounded subset with an explicit warning.',
            ],
            [
              'Progressive deep reads',
              'Threadnote opens four candidate repositories, may use one four-repository ambiguity-validation wave, and reserves 16-repository waves for zero-evidence exhaustion. Concurrency stays bounded at four; stop receipts distinguish sufficient evidence, result budget, work budget, deadline, and exhaustion.',
            ],
            [
              'Agent response budget',
              'The compact text plus structured response defaults to 1,250 estimated tokens and accepts 1 through 1,500 with --budget-tokens or budgetTokens. The envelope counts both transports independently and estimates tokens as total canonical UTF-8 bytes divided by three, rounded up; it is not a provider tokenizer or billing prediction. A legal but tiny budget still fails if mandatory trust and coverage metadata cannot fit. Search breadth is independent from returned card count.',
            ],
            [
              'Logical evidence sequence',
              'Public CLI and MCP execution build a logical sequence of up to 40 evidence cards by default. A separate internal sequence guard permits at most 512 cards for controlled callers; evidenceCards is not a public CLI or MCP input. This bounds the persisted search and continuation sequence, not the first projected response.',
            ],
            [
              'Published scope',
              'A generation supports up to 4,096 members. Routing returns at most 512 repository candidates, while the default deep-read deadline is three seconds.',
            ],
            [
              'Snapshot behavior',
              'Queries read only the exact existing snapshots in the published generation with refresh=false. Building, partial, mismatched, and unready rows are never activated as query evidence.',
            ],
            [
              'Determinism and isolation',
              'Ranking, projection, and continuation are deterministic for the same generation, task, and budget. Repository-qualified identities prevent same-name and sibling-worktree evidence from being conflated.',
            ],
          ],
        },
        {
          type: 'list',
          items: [
            'workset.generation carries the exact cgwg_ ID and digest used for the result.',
            'cards are globally ranked evidence summaries with a cgec_ card ID, repositoryKey, repository-qualified cgr_ ref, symbol path/span, score signals, and bounded adjacent relationships. Within the card budget, the strongest local hit stays first; Threadnote then reserves room for as many as four exact Protobuf bridge endpoints that the local query did not independently rank, followed by the remaining local hits.',
            'A synthesized Protobuf endpoint card contains exact declaration metadata from the generation-bound bridge receipt, language protobuf, the path and span, and a cross-repository-bridge reason—never a source body or guessed name. When both endpoint snapshots are usable, each exact bridge is emitted once on an adjacent returned card, preferring the consumer/import card, as an authoritative, confidence-1, declared relationship with repository-qualified source and target receipts. Relationships are deterministically deduplicated and capped at 32 per card.',
            'coverage separates requestedRepositories, cataloguedRepositories, consideredRepositories, deepQueriedRepositories, per-state counts, complete, and the stopReason.',
            'repositories classify members represented by returned cards and retain exact snapshot, commit, worktree, dirty-overlay, and projection receipts. coverage.states keeps current, stale, deferred, missing, failed, and excluded counts for the complete requested scope even when member receipts are omitted from the compact projection.',
            'output reports returnedCards, omittedCards, totalCards, and whether projection was truncated.',
            'Repository-derived names, paths, snippets, and relationships remain untrusted evidence, never instructions.',
          ],
        },
        {
          type: 'note',
          text: 'coverage.complete means every catalogued ready snapshot was considered by routing. It does not mean every requested member is current, every repository received a deep read, or every possible relationship was returned. Read the state counts, deepQueriedRepositories, stopReason, warnings, and output omissions together.',
        },
        {
          type: 'heading',
          text: '6. Continue without repeating search, or follow an exact handle',
        },
        {
          type: 'code',
          language: 'sh',
          code: `# Continue the persisted globally ranked sequence. No query is required.
threadnote graph query \\
  --workset checkout \\
  --cursor cgwc_… \\
  --budget-tokens 1250 \\
  --json

# Follow a returned repository-qualified symbol without guessing its repository.
threadnote graph node \\
  --cwd ~/src/checkout-api \\
  --node-id cgr_…

threadnote graph neighbors \\
  --cwd ~/src/checkout-api \\
  --node-id cgr_… \\
  --direction incoming`,
        },
        {
          type: 'paragraph',
          text: 'A cgwc_ cursor pages the locally persisted ranked sequence pinned to the original generation; it does not reroute, reopen repositories, or mix in a newer catalog. Publishing a newer generation does not invalidate an unexpired cursor to a retained generation. The 0600-owned disposable result set stores compact evidence cards rather than source bodies and expires after 30 minutes by default. Expired, unknown, or incompatible cursors fail closed; rerun the original query when a cursor is no longer valid.',
        },
        {
          type: 'paragraph',
          text: 'A cgr_ handle binds a local cgs_ node ID to its repository identity. Pass --cwd when the same repository has multiple configured worktrees so Threadnote can select the intended sibling. Local cgs_ IDs remain valid for ordinary one-repository operations.',
        },
        {
          type: 'heading',
          text: '7. Understand which cross-repository edges are authoritative',
        },
        {
          type: 'paragraph',
          text: 'During prepare, Threadnote reads canonical import and export monikers from every ready member and stages either a complete resolved bridge set or an explicit incomplete zero-edge receipt before the generation pointer changes. Each cgb_ bridge binds both repository and snapshot identities, both moniker identities, relation, confidence, resolver reason, and declaration paths/spans on the consumer and producer sides. A snapshot change invalidates the bridge until the next successful prepare revalidates both endpoints.',
        },
        {
          type: 'table',
          headers: ['Supported bridge', 'Exact behavior'],
          rows: [
            [
              'npm package dependency',
              'A declared dependency, devDependency, optionalDependency, or peerDependency import is joined to one exact package export. When both the declaration constraint and producer version exist, the constraint must be a recognized deterministic npm range and match the exact producer SemVer; an unrecognized range fails closed. A missing version leaves exact package identity authoritative. Repository-local extraction retains an npm import alias beside its canonical package name; resolver monikers and bridge identity use the canonical package name, not the alias.',
            ],
            [
              'Protobuf',
              'Native extraction joins an exact .proto file import path to one exporting file in another repository. Package, message, service, and RPC export monikers are recorded for exact identity, but native source extraction does not yet emit corresponding import monikers for those symbol kinds.',
            ],
            [
              'Resolver rejection',
              'Multiple compatible producers produce an ambiguous-producer rejection. Exact npm candidates whose declared and exported versions are incompatible produce an incompatible-package-version rejection. Neither case creates an edge.',
            ],
            [
              'Local or malformed declaration',
              'A same-repository exact producer leaves ownership to the local graph and suppresses external stitching. Malformed or non-canonical identities are skipped or reported during extraction/preparation rather than represented as resolver rejections.',
            ],
            [
              'Authority',
              'Native bridges are declared, confidence 1 evidence. Name similarity, lexical ranking, heuristic edges, and model associations never create an authoritative bridge.',
            ],
          ],
        },
        {
          type: 'warning',
          text: 'Current native stitching is deliberately limited to npm package declarations and exact Protobuf file imports. Protobuf symbol-level imports, GraphQL, OpenAPI and HTTP routes, AsyncAPI and message topics, non-npm package ecosystems, SCIP, configuration-string matching, and name-only or semantic matches are not yet cross-repository bridge protocols. Query can still find their local declarations in several repositories; path and impact will not pretend an unsupported contract is connected.',
        },
        {
          type: 'note',
          text: 'Workset query uses both supported bridge kinds for one-hop repository admission, but their returned evidence differs. An exact native Protobuf bridge has repository-qualified symbol endpoints, so V2 can project missing endpoint cards and the declared import relationship. An npm bridge has package-component endpoints: it can admit the neighboring repository for ordinary deep query, but the component contract is not projected as a query card or card relationship. Inspect npm component contracts through bounded workset path or impact traversal and topology.',
        },
        {
          type: 'heading',
          text: '8. Trace path, impact, and repository topology',
        },
        {
          type: 'code',
          language: 'sh',
          code: `# Symbol endpoints come from workset query cards.
threadnote graph path \\
  --workset checkout \\
  --from cgr_… \\
  --to cgr_… \\
  --depth 6 \\
  --edge-limit 100 \\
  --json

# Reverse impact starts from a repository-qualified symbol or component.
threadnote graph impact \\
  --workset checkout \\
  --query cgr_… \\
  --depth 6 \\
  --edge-limit 100 \\
  --json

# An npm package component endpoint uses <repository-key>:<component-id>.
threadnote graph impact \\
  --workset checkout \\
  --query checkout-api:cgp_… \\
  --json

# Bounded repository/package topology for the complete published bridge set.
threadnote graph topology --workset checkout --json`,
        },
        {
          type: 'code',
          language: 'json',
          code: `{
  "operation": "path",
  "callerCwd": "/workspace/checkout-api",
  "workset": "checkout",
  "from": "cgr_…",
  "to": "cgr_…",
  "depth": 6,
  "edgeLimit": 100
}`,
        },
        {
          type: 'code',
          language: 'json',
          code: `{
  "operation": "impact",
  "callerCwd": "/workspace/checkout-api",
  "workset": "checkout",
  "query": "checkout-api:cgp_…",
  "depth": 6,
  "edgeLimit": 100
}`,
        },
        {
          type: 'code',
          language: 'json',
          code: `{
  "operation": "topology",
  "callerCwd": "/workspace/checkout-api",
  "workset": "checkout",
  "nodeLimit": 128,
  "edgeLimit": 256
}`,
        },
        {
          type: 'paragraph',
          text: 'Workset path performs deterministic shortest forward traversal; impact performs deterministic reverse traversal. Both alternate bounded local graph pages with generation-bound bridge pages, validate that every endpoint snapshot is ready and leased, globally deduplicate repository-qualified endpoints, and return local-versus-bridge provenance plus an explicit target-found, exhaustion, depth, edge-limit, deadline, or unready-start stop receipt.',
        },
        {
          type: 'paragraph',
          text: 'Workset traversal defaults to depth 4 and a two-second internal deadline. CLI defaults to 100 scanned edges; MCP supplies its normal 40-edge default. Both accept depth 0–8 and edgeLimit or --edge-limit 1–500. These are traversal-work bounds, not claims that an early stop is complete; always inspect stop.complete, stop.reason, and coverage.',
        },
        {
          type: 'paragraph',
          text: 'Topology accounts for every repository in the published generation as a candidate, including isolated members, and aggregates declared bridge counts at repository level. Returned nodes are then bounded, so isolated or low-priority repositories may be omitted and counted in coverage.nodes.omitted. npm bridges also produce package-component candidates and edges; Protobuf file bridges contribute to repository-level topology. Coverage reports node, edge, evidence, and bridge omissions separately.',
        },
        {
          type: 'paragraph',
          text: 'Topology first verifies and assembles the complete published bridge set; it is withheld rather than projected from partial bridge pages or unready member snapshots. Public CLI and MCP topology currently have a fixed 20,000-bridge safety ceiling. CLI defaults to 128 nodes and 256 edges; --node-limit and --edge-limit may raise or lower them within 1–200 and 1–500. MCP defaults to 20 nodes and 40 edges with the same maximums. Evidence remains capped at 128 occurrences total and four records per aggregate edge.',
        },
        {
          type: 'note',
          text: 'Threadnote now exposes a cross-repository contract topology, but it still does not merge every local repository graph into one giant graph. Only verified generation-bound bridges cross repository boundaries; local relationship provenance and declared bridge provenance remain distinct.',
        },
        {
          type: 'heading',
          text: '9. Compile a Context Brief for an agent',
        },
        {
          type: 'code',
          language: 'sh',
          code: `# Current repository scope (uses the current working directory).
threadnote context brief \\
  --task "Find where checkout retries are implemented and what constrains them" \\
  --budget-tokens 1250 \\
  --json

# Prepared workset scope.
threadnote context brief \\
  --task "Trace checkout retries across the API, client, and shared contracts" \\
  --workset checkout \\
  --mode trace \\
  --budget-tokens 1250 \\
  --json`,
        },
        {
          type: 'code',
          language: 'json',
          code: `{
  "task": "Trace checkout retries across the API, client, and shared contracts",
  "callerCwd": "/workspace/checkout-api",
  "workset": "checkout",
  "mode": "trace",
  "budgetTokens": 1250
}`,
        },
        {
          type: 'paragraph',
          text: 'Pass the JSON payload to context_brief. The compiler uses a small typed request rather than exposing its internal plan. It combines ranked graph cards and contracts with relevant durable decisions, active handoffs, graph and memory coverage, fresh, stale, or unknown memory status, conflicts, gaps, and stable recommended follow-ups. Repository evidence and memory excerpts remain separate untrusted evidence classes.',
        },
        {
          type: 'paragraph',
          text: 'CLI repository scope defaults to the current directory; an explicit --cwd must be absolute. MCP always requires absolute callerCwd. --workset scopes graph retrieval only: memory recall remains global unless --project or project narrows it independently. Modes are brief, locate, explain, trace, and impact; they tune the bounded internal evidence plan without becoming query syntax.',
        },
        {
          type: 'warning',
          text: 'Coarse memory freshness is fresh or stale only when exactly one repository snapshot resolves and a memory’s sourceCommit exactly matches or differs from that snapshot. A normal multi-repository workset brief therefore reports memory freshness as unknown today. The precise exact/relocated/changed/deleted citation validator exists as an internal boundary but is not yet wired to ordinary memory records.',
        },
        {
          type: 'paragraph',
          text: 'Context Brief uses the same combined text-plus-structured UTF-8 estimate, defaults to 1,250 tokens, and accepts at most 1,500. A legal but tiny budget fails when mandatory scope, trust, and coverage metadata cannot fit. Its output receipt reports returned and omitted items. When the workset graph has more evidence, the brief can return a cgwc_ continuation; when the brief budget omitted the corresponding cards, it tells the caller to rerun instead of exposing a misleading cursor. It never mutates repository source or creates, approves, edits, or publishes canonical memory. Workset mode may register cgr_ handles and persist the same disposable local result-set state used for continuation.',
        },
        {
          type: 'warning',
          text: 'Context Brief v1 does not automatically run workset path, reverse impact, or topology. Its graph cards and contracts come from the bounded V2 query projection and retained card relationships, including an exact Protobuf bridge relationship when that query projected one; it does not traverse beyond those returned cards. Call inspect_code_graph path, impact, or topology separately when explicit bridge traversal is consequential to the task.',
        },
        {
          type: 'note',
          text: 'CLI text output is intentionally a one-line receipt; use --json to consume the evidence arrays and follow-ups. MCP returns the terse receipt in content and the complete bounded projection in structuredContent.',
        },
        {
          type: 'heading',
          text: '10. Performance expectations and evaluation gates',
        },
        {
          type: 'table',
          headers: ['Expectation', 'Contract'],
          rows: [
            [
              'Ready-workset latency',
              'The reference 50-repository engineering targets are p95 buffered delivered-first-evidence at or below one second, completion at or below three seconds, and an agent response at or below 1,500 estimated tokens. At 128 repositories, the completion target is at or below five seconds with the same token ceiling. The benchmark enforces these only when run with --fail-on-budget; they are not network service SLAs.',
            ],
            [
              'First evidence',
              'CLI and MCP currently buffer the compact projection, so observable time to first evidence equals full response completion. Threadnote does not claim progressive sub-second streaming until the transport emits cards incrementally.',
            ],
            [
              'Quality',
              'Regression fixtures cover 1, 8, 32, 64, and 128 repositories and track top-k repository, symbol, and edge recall, false authoritative edges, no-answer precision/recall, coverage truthfulness, and worktree leakage.',
            ],
            [
              'Token growth',
              'Adding irrelevant repositories may increase indexed routing work, but it must not linearly inflate the returned evidence envelope. Use continuation or a narrower task instead of requesting repository dumps.',
            ],
          ],
        },
        {
          type: 'heading',
          text: '11. Troubleshooting',
        },
        {
          type: 'table',
          headers: ['Symptom', 'What to do'],
          rows: [
            [
              'No published catalog or catalog-generation drift',
              'Run threadnote workset status <name>, then threadnote workset prepare <name>. Query intentionally refuses to build or silently use a mismatched generation.',
            ],
            [
              'Member is missing, deferred, failed, stale, or uncatalogued',
              'Check its configured path and threadnote graph status --cwd <path>. Repair a repository-local graph problem if needed, then prepare the workset again.',
            ],
            [
              'Bridge coverage is partial or failed',
              'Inspect the JSON status or prepare receipt. Threadnote withholds the complete bridge set when any ready member’s canonical monikers cannot be read; fix the member and prepare again.',
            ],
            [
              'Expected cross-repository edge is absent',
              'Check whether the contract is supported, ambiguous, version-incompatible, or owned locally. Same names alone are intentionally insufficient; use ordinary query evidence and inspect each repository when no bridge exists.',
            ],
            [
              'Response is truncated',
              'Follow continuation.cursor, increase budgetTokens only up to 1,500, or ask a narrower question. Coverage and trust remain present even when evidence cards are omitted.',
            ],
            [
              'Budget is too small',
              'Increase --budget-tokens or budgetTokens until the mandatory generation/scope, trust, coverage, and omission receipt fits. Threadnote errors instead of silently dropping those fields.',
            ],
            [
              'Cursor is expired, unknown, or incompatible',
              'Rerun the original task query to create a new pinned result set. A newly published generation alone does not invalidate an unexpired cursor. Do not edit or decode the opaque cgwc_ handle.',
            ],
            [
              'cgr_ matches multiple worktrees',
              'Pass --cwd or callerCwd for the intended configured worktree. Threadnote fails on ambiguity rather than choosing a sibling and leaking its evidence.',
            ],
            [
              'Path or impact stops early',
              'Read the stop reason and coverage counters. Reduce scope, raise the normal depth or edge limit within supported bounds, prepare stale members, or treat unsupported bridge protocols as an explicit gap.',
            ],
          ],
        },
      ],
    },
    {
      id: 'memory-hygiene',
      title: 'Archive, compact, and forget',
      summary: 'Preserve provenance while keeping active recall current and focused.',
      body: [
        {
          type: 'code',
          language: 'sh',
          code: `threadnote compact --project payments --dry-run
threadnote compact --project payments --apply
threadnote archive <threadnote-uri>
threadnote forget <threadnote-uri> --dry-run`,
        },
        {
          type: 'paragraph',
          text: 'Compact is scoped and previews by default. It can archive stale handoffs and remove exact duplicates while preserving the selected current record. Archive writes provenance before removing the active source. Forget removes local canonical context and should be previewed when the target is broad.',
        },
      ],
    },
  ],
};
