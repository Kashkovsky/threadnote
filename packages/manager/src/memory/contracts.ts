import type {MemoryRelation} from '@threadnote/memory/document';

export interface ManagerMemoryRelationsResponse {
  readonly content: string;
  readonly memoryId: string;
  readonly relations: readonly MemoryRelation[];
  readonly uri: string;
}
