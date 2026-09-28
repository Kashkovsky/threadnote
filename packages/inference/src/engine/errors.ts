import {Schema} from 'effect';

export class NativeRuntimeUnavailable extends Schema.TaggedError<NativeRuntimeUnavailable>()(
  'NativeRuntimeUnavailable',
  {
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

export class UnsupportedNativeRuntime extends Schema.TaggedError<UnsupportedNativeRuntime>()(
  'UnsupportedNativeRuntime',
  {
    cause: Schema.Defect(),
    message: Schema.String,
  },
) {}

export class ModelNotInstalled extends Schema.TaggedError<ModelNotInstalled>()('ModelNotInstalled', {
  modelId: Schema.String,
  path: Schema.String,
  message: Schema.String,
}) {}

export class ModelManifestInvalid extends Schema.TaggedError<ModelManifestInvalid>()('ModelManifestInvalid', {
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class ModelChecksumMismatch extends Schema.TaggedError<ModelChecksumMismatch>()('ModelChecksumMismatch', {
  actual: Schema.String,
  expected: Schema.String,
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class ModelDownloadFailed extends Schema.TaggedError<ModelDownloadFailed>()('ModelDownloadFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class InsufficientDiskSpace extends Schema.TaggedError<InsufficientDiskSpace>()('InsufficientDiskSpace', {
  availableBytes: Schema.Finite,
  message: Schema.String,
  modelId: Schema.String,
  requiredBytes: Schema.Finite,
}) {}

export class ModelLoadFailed extends Schema.TaggedError<ModelLoadFailed>()('ModelLoadFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class InsufficientMemory extends Schema.TaggedError<InsufficientMemory>()('InsufficientMemory', {
  cause: Schema.Defect(),
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class EmbeddingFailed extends Schema.TaggedError<EmbeddingFailed>()('EmbeddingFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class RerankingFailed extends Schema.TaggedError<RerankingFailed>()('RerankingFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class GenerationFailed extends Schema.TaggedError<GenerationFailed>()('GenerationFailed', {
  cause: Schema.Defect(),
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class InvalidModelOutput extends Schema.TaggedError<InvalidModelOutput>()('InvalidModelOutput', {
  message: Schema.String,
  modelId: Schema.String,
}) {}

export class InferenceInterrupted extends Schema.TaggedError<InferenceInterrupted>()('InferenceInterrupted', {
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
