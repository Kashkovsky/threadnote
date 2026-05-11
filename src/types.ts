export type AgentClient = 'claude' | 'codex' | 'cursor';
export type ClaudeMcpScope = 'local' | 'project' | 'user';
export type CommandStatus = 'fail' | 'ok' | 'warn';
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
  readonly source: string;
}

export interface MappedCommand {
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly executable: string;
}

export interface InstallOptions {
  readonly dryRun?: boolean;
  readonly packageManager?: PackageManager;
  readonly printNextSteps?: boolean;
  readonly repairInvalidConfigs?: boolean;
  readonly start?: boolean;
}

export interface RepairOptions {
  readonly dryRun?: boolean;
  readonly mcp?: string;
  readonly packageManager?: PackageManager;
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
  readonly registry?: string;
  readonly repair?: boolean;
  readonly runtime?: UpdateRuntime;
}

export interface DoctorOptions {
  readonly dryRun?: boolean;
  readonly strict?: boolean;
}

export interface StartOptions {
  readonly dryRun?: boolean;
  readonly foreground?: boolean;
  readonly launchd?: boolean;
}

export interface SeedOptions {
  readonly dryRun?: boolean;
  readonly manifest?: string;
  readonly native?: boolean;
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
  readonly sourceAgentClient?: string;
  readonly stdin?: boolean;
  readonly text?: string;
}

export interface MigrateMemoriesOptions {
  readonly allAccounts?: boolean;
  readonly dryRun?: boolean;
  readonly limit?: string;
  readonly sourceAccount?: readonly string[];
}

export interface RecallOptions {
  readonly dryRun?: boolean;
  readonly inferScope?: boolean;
  readonly nodeLimit?: string;
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
  readonly sourceAgentClient?: string;
  readonly task?: string;
  readonly tests?: string;
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
