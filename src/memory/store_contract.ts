import type {MemoryMetadata} from './document.js';
import type {DeferredCodeAnchorWriteRequest} from './deferred_code_anchor.js';

export interface StoreMemoryOptions {
  readonly bodyText: string;
  readonly dryRun: boolean;
  readonly deferredCodeAnchor?: DeferredCodeAnchorWriteRequest;
  readonly expectedReplaceContent?: string;
  readonly expectedReplaceRawContent?: string;
  readonly expectedSourceContent?: readonly {
    readonly allowedUriScopes?: readonly string[];
    readonly content: string;
    readonly memoryId?: string;
    readonly uri: string;
  }[];
  /** Nested lifecycle writers already hold the source lock and skip the identity fence to avoid lock inversion. */
  readonly skipMemoryIdentityLock?: boolean;
  readonly metadata: MemoryMetadata;
  readonly replaceUri?: string;
  readonly title: 'MEMORY' | 'HANDOFF';
}
