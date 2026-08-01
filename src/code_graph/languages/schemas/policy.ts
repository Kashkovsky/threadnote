const LOW_SIGNAL_STRUCTURED_PATH =
  /(?:^|\/)(?:__snapshots__|snapshots?|goldens?|fixtures?|oplogs?|evaluations?|evals?|datasets?|test[-_]?data|animations?)(?:\/|$)|(?:^|\/)[^/]*(?:snapshot|golden|fixture|oplog|evaluation|dataset|animation)[^/]*\.(?:jsonc?|ya?ml)$/i;

const RECOGNIZED_STRUCTURED_PATH =
  /(?:^|\/)(?:configs?|configuration|schemas?|settings|openapi|swagger|specifications?)(?:\/|$)|(?:^|\/)[^/]*(?:config|schema|settings|openapi|swagger|specification)[^/]*\.(?:jsonc?|ya?ml)$/i;

export function isLowSignalStructuredPath(path: string): boolean {
  return LOW_SIGNAL_STRUCTURED_PATH.test(path);
}

export function isRecognizedStructuredPath(path: string): boolean {
  return RECOGNIZED_STRUCTURED_PATH.test(path);
}
