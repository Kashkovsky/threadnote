'use strict';

function shouldSuppressNodeWarning(warning, typeOrOptions) {
  const message = warning instanceof Error ? warning.message : String(warning);
  const type =
    typeof typeOrOptions === 'string'
      ? typeOrOptions
      : typeOrOptions && typeof typeOrOptions === 'object'
        ? typeOrOptions.type
        : warning instanceof Error
          ? warning.name
          : undefined;
  return type === 'ExperimentalWarning' && /^SQLite is an experimental feature\b/.test(message);
}

function suppressThreadnoteSQLiteExperimentalWarning() {
  const original = process.emitWarning;
  process.emitWarning = function filteredEmitWarning(warning, ...args) {
    if (shouldSuppressNodeWarning(warning, args[0])) return;
    return Reflect.apply(original, this, [warning, ...args]);
  };
}

module.exports = {shouldSuppressNodeWarning, suppressThreadnoteSQLiteExperimentalWarning};
