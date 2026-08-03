import {Effect} from 'effect';
import {LocalModelRuntime, type LocalGenerationRequest} from '../effect/ai/local-model-runtime.js';
import type {StructuredGenerationRequest} from '../effect/ai/structured-generator.js';
import {LocalModelCatalog, type LocalModelManifest, type LocalModelRole} from './catalog.js';
import {readModelSelection} from './selection.js';
import {LocalModelStore} from './store.js';

export interface SelectedLocalModel {
  readonly manifest: LocalModelManifest;
  readonly path: string;
}

export const resolveSelectedLocalModel = Effect.fn('models.resolveSelected')(function* (
  home: string,
  role: LocalModelRole,
) {
  const selection = yield* readModelSelection(home);
  const modelId = selection.roles[role];
  if (!modelId) return undefined;
  const catalog = yield* LocalModelCatalog;
  const manifest = yield* catalog.get(modelId);
  if (manifest.role !== role) return undefined;
  const store = yield* LocalModelStore;
  const status = yield* store.status(home, manifest);
  return status.installed ? ({manifest, path: status.path} satisfies SelectedLocalModel) : undefined;
});

export const generateWithSelectedLocalModel = Effect.fn('models.generateSelected')(function* (
  home: string,
  request: StructuredGenerationRequest,
) {
  const selected = yield* resolveSelectedLocalModel(home, 'generation');
  if (!selected) return undefined;
  const runtime = yield* LocalModelRuntime;
  return yield* runtime.generate({
    ...request,
    manifest: selected.manifest,
    modelPath: selected.path,
  } satisfies LocalGenerationRequest);
});

export const rerankWithSelectedLocalModel = Effect.fn('models.rerankSelected')(function* (
  home: string,
  query: string,
  documents: readonly string[],
) {
  const selected = yield* resolveSelectedLocalModel(home, 'reranker');
  if (!selected) return undefined;
  const runtime = yield* LocalModelRuntime;
  return yield* runtime.rerank({
    documents,
    manifest: selected.manifest,
    modelPath: selected.path,
    query,
  });
});
