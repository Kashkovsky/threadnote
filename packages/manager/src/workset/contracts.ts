import type {ProjectManifest} from '@threadnote/workspace/config';
import type {
  CodeGraphWorksetPrepareProgressV1,
  CodeGraphWorksetPrepareResultV1,
} from '@threadnote/graph/workset_catalog/workset';

export interface ManagerWorksetDefinitionMember {
  readonly branch?: string;
  readonly branchState: 'current' | 'detached' | 'missing' | 'not-observed';
  readonly configured: boolean;
  readonly folder?: string;
  readonly path?: string;
  readonly project: string;
  /** Present for configured members; sourced from the definition manifest snapshot. */
  readonly uri?: string;
}

export interface ManagerWorksetProjectSummary {
  readonly branch?: string;
  readonly branchState: 'current' | 'detached' | 'missing' | 'not-observed';
  readonly folder: string;
  readonly name: string;
  readonly path: string;
  readonly worksets: readonly string[];
  readonly worksetCount: number;
}

export interface ManagerManifestProject {
  readonly graph?: ProjectManifest['graph'];
  readonly name: string;
  readonly path: string;
  readonly seed: readonly string[];
  readonly uri: string;
}

export interface ManagerWorksetDefinition {
  readonly configuredMembers: number;
  readonly description?: string;
  readonly members: readonly ManagerWorksetDefinitionMember[];
  readonly name: string;
  readonly unresolvedMembers: number;
}

export interface ManagerWorksetDefinitionSummary {
  readonly description?: string;
  readonly memberCount: number;
  readonly name: string;
}

export interface ManagerWorksetCatalog {
  readonly definitions: readonly ManagerWorksetDefinitionSummary[];
  readonly definitionSource: 'seed-manifest';
  readonly editability: {
    readonly reason?: 'manifest-symlink' | 'unsupported-workset-yaml';
    readonly state: 'editable' | 'read-only';
  };
  readonly projectEditability: {
    readonly reason?: 'manifest-symlink' | 'unsupported-project-yaml';
    readonly state: 'editable' | 'read-only';
  };
  readonly projects: readonly ManagerWorksetProjectSummary[];
  readonly projectsReadOnly: boolean;
  readonly readOnly: boolean;
  readonly revision: string;
  readonly type: 'manager-workset-catalog';
  readonly version: 1;
}

export type ManagerWorksetDefinitionMutation =
  | {
      readonly description?: string;
      readonly expectedRevision: string;
      readonly name: string;
      readonly operation: 'create';
      readonly projects: readonly string[];
    }
  | {
      readonly description?: string;
      readonly expectedRevision: string;
      readonly name: string;
      readonly operation: 'update';
      readonly projects: readonly string[];
      readonly workset: string;
    }
  | {
      readonly confirm: true;
      readonly expectedRevision: string;
      readonly operation: 'delete';
      readonly workset: string;
    };

export interface ManagerWorksetDefinitionMutationResult {
  readonly catalog: ManagerWorksetCatalog;
  readonly changed: boolean;
  readonly operation: ManagerWorksetDefinitionMutation['operation'];
  readonly warnings: readonly string[];
}

export type ManagerManifestProjectMutation =
  | {
      readonly expectedRevision: string;
      readonly graph?: ProjectManifest['graph'];
      readonly name: string;
      readonly operation: 'create';
      readonly path: string;
      readonly seed: readonly string[];
      readonly uri: string;
    }
  | {
      readonly clearGraph?: true;
      readonly expectedRevision: string;
      readonly graph?: ProjectManifest['graph'];
      readonly name: string;
      readonly operation: 'update';
      readonly path: string;
      readonly project: string;
      readonly seed: readonly string[];
      readonly uri: string;
    }
  | {
      readonly confirm: true;
      readonly expectedRevision: string;
      readonly operation: 'delete';
      readonly project: string;
    };

export interface ManagerManifestProjectMutationResult {
  readonly catalog: ManagerWorksetCatalog;
  readonly changed: boolean;
  readonly operation: ManagerManifestProjectMutation['operation'];
  readonly warnings: readonly string[];
}

export type ManagerWorksetJobStatus = 'cancelled' | 'cancelling' | 'completed' | 'failed' | 'running';

export interface ManagerWorksetPrepareJob {
  readonly createdAt: string;
  readonly error?: string;
  readonly errorCode?: string;
  readonly finishedAt?: string;
  readonly id: string;
  readonly progress: {
    readonly activity?: CodeGraphWorksetPrepareProgressV1['activity'];
    readonly attempt?: number;
    readonly completed?: number;
    readonly elapsedMilliseconds?: number;
    readonly maxAttempts?: number;
    readonly message: string;
    readonly phase: 'cancelled' | 'cancelling' | CodeGraphWorksetPrepareProgressV1['phase'];
    readonly project?: string;
    readonly total: number;
  };
  readonly result?: CodeGraphWorksetPrepareResultV1;
  readonly status: ManagerWorksetJobStatus;
  readonly warning?: string;
  readonly workset: string;
}

export type ManagerWorksetPrepareJobSummary = Omit<ManagerWorksetPrepareJob, 'result'>;

export interface ManagerWorksetApiResponse {
  readonly body: unknown;
  readonly status: number;
}
