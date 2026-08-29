import type {MemoryMetadata} from './document.js';

export interface StoreMemoryOptions {
  readonly bodyText: string;
  readonly dryRun: boolean;
  readonly expectedReplaceContent?: string;
  readonly expectedReplaceRawContent?: string;
  readonly metadata: MemoryMetadata;
  readonly replaceUri?: string;
  readonly title: 'MEMORY' | 'HANDOFF';
}
