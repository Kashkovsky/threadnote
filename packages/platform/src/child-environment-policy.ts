import {Context} from 'effect';

export interface ChildEnvironmentPolicyShape {
  readonly preserveIntendedChild: (environment: NodeJS.ProcessEnv, childKind: string) => NodeJS.ProcessEnv;
  readonly sanitizeExternal: (environment: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}

export class ChildEnvironmentPolicy extends Context.Service<ChildEnvironmentPolicy, ChildEnvironmentPolicyShape>()(
  '@threadnote/platform/child-environment-policy/ChildEnvironmentPolicy',
) {}
