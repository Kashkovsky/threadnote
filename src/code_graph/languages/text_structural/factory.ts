import {Effect, Option} from 'effect';
import {sha256HexSync} from '../../../crypto/sha256.js';
import type {CodeGraphCapability, CodeGraphFileMatcher, CodeGraphLanguagePack} from '../types.js';
import {CodeGraphLanguagePackError} from '../types.js';
import {extractTextStructuralFacts} from './extractor.js';

export interface TextStructuralLanguagePackOptions {
  readonly capabilities: ReadonlySet<CodeGraphCapability>;
  readonly files: readonly CodeGraphFileMatcher[];
  readonly id: string;
  readonly resolutionDomain: string;
  readonly version: string;
}

export function createTextStructuralLanguagePack(options: TextStructuralLanguagePackOptions): CodeGraphLanguagePack {
  return {
    assets: [],
    capabilities: options.capabilities,
    extractor: {
      extract: (file, context) =>
        Effect.try({
          try: () => extractTextStructuralFacts(file, context, options.resolutionDomain),
          catch: cause =>
            new CodeGraphLanguagePackError(`Could not extract bounded ${options.id} structure from ${file.path}.`, {
              cause,
            }),
        }),
      version: sha256HexSync(`threadnote-text-structural-v1\n${options.id}\n${options.version}`),
    },
    files: options.files,
    id: options.id,
    resolutionStrategy: {
      domain: options.resolutionDomain,
      version: `${options.resolutionDomain}-text-structural-v1`,
    },
    version: options.version,
    workspaceDetector: Option.none(),
  };
}
