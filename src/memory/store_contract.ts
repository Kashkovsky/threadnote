import type {MemoryMetadata} from './document.js';
import type {DeferredCodeAnchorWriteRequest} from './deferred_code_anchor.js';

export interface StoreMemoryOptions {
  readonly bodyText: string;
  readonly dryRun: boolean;
  readonly deferredCodeAnchor?: DeferredCodeAnchorWriteRequest;
  readonly expectedReplaceContent?: string;
  readonly expectedReplaceRawContent?: string;
  readonly metadata: MemoryMetadata;
  readonly replaceUri?: string;
  readonly title: 'MEMORY' | 'HANDOFF';
}
