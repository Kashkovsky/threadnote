import {telemetryChildEnvironmentPolicy} from '@threadnote/threadnote/telemetry/session';
import type {SystemInfoShape} from '@threadnote/platform/system';

export const systemRuntimeBoundaries = {
  developmentEntrypoint: Bun.fileURLToPath(new URL('../../src/standalone.ts', import.meta.url)),
  intendedChildEnvironment: telemetryChildEnvironmentPolicy.preserveIntendedChild,
} satisfies Pick<SystemInfoShape, 'developmentEntrypoint' | 'intendedChildEnvironment'>;
