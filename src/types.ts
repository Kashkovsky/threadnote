export type AgentClient = 'claude' | 'codex' | 'copilot' | 'cursor';
export type ClaudeMcpScope = 'local' | 'project' | 'user';
export type CommandStatus = 'fail' | 'ok' | 'warn';
export type MemoryKind = 'durable' | 'handoff' | 'incident' | 'preference' | 'smoke';
export type MemoryStatus = 'active' | 'archived' | 'superseded';
export type PackageManager = 'pip' | 'pipx' | 'uv';
export type UpdateRuntime = 'auto' | 'bun' | 'deno' | 'npm';

export interface RuntimeConfig {
  readonly account: string;
  readonly agentContextHome: string;
  readonly agentId: string;
  readonly host: string;
  readonly manifestPath: string;
  readonly openVikingVersion: string;
  readonly port: number;
  readonly user: string;
}

export interface ProjectManifest {
  readonly name: string;
  readonly path: string;
  readonly seed: readonly string[];
  readonly uri: string;
}

export interface SeedManifest {
  readonly futureMonorepo?: {
    readonly pathCandidates: readonly string[];
    readonly uri: string;
  };
  readonly projects: readonly ProjectManifest[];
  readonly version: number;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface DoctorCheck {
  readonly detail: string;
  readonly name: string;
  readonly status: CommandStatus;
}

export interface SeedCandidate {
  readonly destinationUri: string;
  readonly filePath: string;
  readonly projectName: string;
  readonly relativePath: string;
}

export interface SkillCandidate {
  readonly filePath: string;
  readonly hash: string;
  readonly kind: 'command' | 'skill';
  readonly source: string;
}

export interface MappedCommand {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly executable: string;
}

export interface InstallOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly packageManager?: PackageManager;
  readonly printNextSteps?: boolean;
  readonly repairInvalidConfigs?: boolean;
  readonly start?: boolean;
  readonly withHooks?: boolean;
}

export interface HooksInstallOptions {
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly remove?: boolean;
}

export interface HookRunnerOptions {
  readonly dryRun?: boolean;
}

export interface RepairOptions {
  readonly dryRun?: boolean;
  readonly mcp?: string;
  readonly packageManager?: PackageManager;
  readonly postUpdate?: boolean;
  readonly start?: boolean;
}

export interface UninstallOptions {
  readonly dryRun?: boolean;
  readonly eraseMemories?: boolean;
  readonly mcp?: string;
  readonly preserveMemories?: boolean;
}

export interface UpdateOptions {
  readonly check?: boolean;
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly postUpdate?: boolean;
  readonly registry?: string;
  readonly repair?: boolean;
  readonly runtime?: UpdateRuntime;
  readonly yes?: boolean;
}

export interface VersionOptions {
  readonly registry?: string;
}

export interface PostUpdateOptions {
  readonly dryRun?: boolean;
  readonly fromVersion?: string;
  readonly toVersion?: string;
  readonly yes?: boolean;
}

export interface DoctorOptions {
  readonly dryRun?: boolean;
  readonly strict?: boolean;
}

export interface ManageOptions {
  readonly open?: boolean;
  readonly uiPort?: string;
}

export interface StartOptions {
  readonly dryRun?: boolean;
  readonly foreground?: boolean;
  readonly launchd?: boolean;
}

export interface SeedOptions {
  readonly dryRun?: boolean;
  readonly force?: boolean;
  readonly manifest?: string;
  readonly native?: boolean;
  readonly only?: readonly string[];
}

export interface McpInstallOptions {
  readonly apply?: boolean;
  readonly bearerTokenEnvVar?: string;
  readonly name?: string;
  readonly nativeHttp?: boolean;
  readonly scope?: ClaudeMcpScope;
  readonly url?: string;
}

export interface RememberOptions {
  readonly dryRun?: boolean;
  readonly kind?: MemoryKind;
  readonly project?: string;
  readonly replace?: string;
  readonly sourceAgentClient?: string;
  readonly status?: MemoryStatus;
  readonly stdin?: boolean;
  readonly text?: string;
  readonly topic?: string;
}

export interface CompactOptions {
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly kind?: Extract<MemoryKind, 'durable' | 'handoff' | 'incident'>;
  readonly project?: string;
  readonly topic?: string;
}

export interface MigrateMemoriesOptions {
  readonly allAccounts?: boolean;
  readonly dryRun?: boolean;
  readonly limit?: string;
  readonly sourceAccount?: readonly string[];
}

export interface MigrateLifecycleOptions {
  readonly apply?: boolean;
  readonly dryRun?: boolean;
  readonly limit?: string;
}

export interface RecallOptions {
  readonly dryRun?: boolean;
  readonly inferScope?: boolean;
  readonly includeArchived?: boolean;
  readonly nodeLimit?: string;
  readonly project?: string;
  readonly query: string;
  readonly uri?: string;
}

export interface ReadOptions {
  readonly dryRun?: boolean;
}

export interface ListOptions {
  readonly all?: boolean;
  readonly dryRun?: boolean;
  readonly nodeLimit?: string;
  readonly recursive?: boolean;
  readonly simple?: boolean;
}

export interface HandoffOptions {
  readonly blockers?: string;
  readonly dryRun?: boolean;
  readonly nextStep?: string;
  readonly project?: string;
  readonly replace?: string;
  readonly sourceAgentClient?: string;
  readonly task?: string;
  readonly tests?: string;
  readonly timestamped?: boolean;
  readonly topic?: string;
}

export interface ArchiveOptions {
  readonly dryRun?: boolean;
  readonly kind?: MemoryKind;
  readonly project?: string;
  readonly topic?: string;
}

export interface PackOptions {
  readonly dryRun?: boolean;
  readonly path?: string;
  readonly targetUri?: string;
  readonly uri?: string;
}

export interface ForgetOptions {
  readonly dryRun?: boolean;
}

export interface InitManifestOptions {
  readonly dryRun?: boolean;
  readonly path?: string;
  readonly replace?: boolean;
  readonly repo?: readonly string[];
}

export interface JsonObject {
  readonly [key: string]: unknown;
}

export interface ShareRuntime {
  readonly account: string;
  readonly agentContextHome: string;
  readonly agentId: string;
  readonly user: string;
}

export interface ShareTeamConfig {
  readonly addedAt: string;
  readonly gitdir: string;
  readonly name: string;
  readonly remote: string;
  readonly worktree: string;
}

export interface ShareTeamsFile {
  readonly defaultTeam?: string;
  readonly teams: Readonly<Record<string, ShareTeamConfig>>;
  readonly version: number;
}

export interface ShareInitOptions {
  readonly dryRun?: boolean;
  readonly push?: boolean;
  readonly setDefault?: boolean;
  readonly team?: string;
}

export interface ShareStatusOptions {
  readonly dryRun?: boolean;
  readonly team?: string;
}

export interface ShareSyncOptions {
  readonly autoCommit?: boolean;
  readonly dryRun?: boolean;
  readonly message?: string;
  readonly push?: boolean;
  readonly team?: string;
}

export interface SharePublishOptions {
  readonly dryRun?: boolean;
  readonly message?: string;
  readonly preview?: boolean;
  readonly push?: boolean;
  readonly redact?: boolean;
  readonly team?: string;
}

export interface ShareUnpublishOptions {
  readonly dryRun?: boolean;
  readonly message?: string;
  readonly push?: boolean;
  readonly team?: string;
}

export interface ShareListOptions {
  readonly dryRun?: boolean;
}

export interface ShareRenameOptions {
  readonly dryRun?: boolean;
  readonly team?: string;
  readonly to?: string;
}

export interface ShareSetUrlOptions {
  readonly dryRun?: boolean;
  readonly team?: string;
}

export interface ShareRemoveOptions {
  readonly dryRun?: boolean;
  readonly keepFiles?: boolean;
  readonly preserveLocal?: boolean;
  readonly team?: string;
}
