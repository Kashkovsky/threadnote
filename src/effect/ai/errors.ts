import {Schema} from 'effect';

export class NativeRuntimeUnavailable extends Schema.TaggedErrorClass<NativeRuntimeUnavailable>()(
  'NativeRuntimeUnavailable',
  {
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

export class UnsupportedNativeRuntime extends Schema.TaggedErrorClass<UnsupportedNativeRuntime>()(
  'UnsupportedNativeRuntime',
  {
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

export class ModelNotInstalled extends Schema.TaggedErrorClass<ModelNotInstalled>()('ModelNotInstalled', {
  modelId: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

export class ModelManifestInvalid extends Schema.TaggedErrorClass<ModelManifestInvalid>()('ModelManifestInvalid', {
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class ModelChecksumMismatch extends Schema.TaggedErrorClass<ModelChecksumMismatch>()('ModelChecksumMismatch', {
  actual: Schema.String,
  expected: Schema.String,
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class ModelDownloadFailed extends Schema.TaggedErrorClass<ModelDownloadFailed>()('ModelDownloadFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class InsufficientDiskSpace extends Schema.TaggedErrorClass<InsufficientDiskSpace>()('InsufficientDiskSpace', {
  availableBytes: Schema.Number,
  message: Schema.String,
  modelId: Schema.String,
  requiredBytes: Schema.Number,
}) {}

export class ModelLoadFailed extends Schema.TaggedErrorClass<ModelLoadFailed>()('ModelLoadFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class InsufficientMemory extends Schema.TaggedErrorClass<InsufficientMemory>()('InsufficientMemory', {
  cause: Schema.Defect(),
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class EmbeddingFailed extends Schema.TaggedErrorClass<EmbeddingFailed>()('EmbeddingFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class RerankingFailed extends Schema.TaggedErrorClass<RerankingFailed>()('RerankingFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class GenerationFailed extends Schema.TaggedErrorClass<GenerationFailed>()('GenerationFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class InvalidModelOutput extends Schema.TaggedErrorClass<InvalidModelOutput>()('InvalidModelOutput', {
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class InferenceInterrupted extends Schema.TaggedErrorClass<InferenceInterrupted>()('InferenceInterrupted', {
  message: Schema.String,
  modelId: Schema.String,
  operation: Schema.String,
}) {}

export type NativeRuntimeError = NativeRuntimeUnavailable | UnsupportedNativeRuntime;
export type ModelSessionError =
  | EmbeddingFailed
  | InferenceInterrupted
  | InsufficientMemory
  | ModelLoadFailed
  | ModelNotInstalled
  | NativeRuntimeError;
