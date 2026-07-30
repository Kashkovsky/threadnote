import {Effect, Option} from 'effect';
import type {TreeSitterRuntime} from '../tree_sitter/runtime.js';
import type {CodeGraphFileFacts, CodeGraphInventoryFile} from '../types.js';

export type CodeGraphFileRole = 'documentation' | 'manifest' | 'source' | 'workspace';
export type CodeGraphCapability =
  'calls' | 'declarations' | 'dependencies' | 'documentation' | 'imports' | 'inheritance' | 'workspace';

export type CodeGraphFileMatcher =
  | {
      readonly kind: 'basename';
      readonly language: string;
      readonly role: CodeGraphFileRole;
      readonly value: string;
    }
  | {
      readonly kind: 'extension';
      readonly language: string;
      readonly role: CodeGraphFileRole;
      readonly value: string;
    }
  | {
      readonly kind: 'path-suffix';
      readonly language: string;
      readonly role: CodeGraphFileRole;
      readonly value: string;
    };

export interface VerifiedLanguageAsset {
  readonly abi: number;
  readonly relativePath: string;
  readonly sha256: string;
  readonly source: string;
  readonly version: string;
}

export interface CodeGraphExtractionContext {
  readonly packageName: Option.Option<string>;
  readonly project: Option.Option<CodeGraphWorkspaceProject>;
}

export interface CodeGraphWorkspaceProject {
  readonly dependencies: readonly string[];
  readonly id: string;
  readonly languages: readonly string[];
  readonly name: string;
  readonly resolutionDomain: string;
  readonly root: string;
  readonly sourceRoots: readonly string[];
  readonly workspaceRoots: readonly string[];
}

export interface CodeGraphWorkspace {
  readonly diagnostics: readonly string[];
  readonly fingerprint: string;
  readonly projects: readonly CodeGraphWorkspaceProject[];
}

export interface CodeGraphWorkspaceDetector {
  readonly contextFiles: readonly CodeGraphFileMatcher[];
  readonly detect: (
    files: readonly CodeGraphInventoryFile[],
  ) => Effect.Effect<CodeGraphWorkspace, CodeGraphLanguagePackError>;
}

export interface CodeGraphResolutionStrategy {
  readonly domain: string;
  readonly version: string;
}

export interface CodeGraphExtractor {
  readonly version: string;
  readonly extract: (
    file: CodeGraphInventoryFile,
    context: CodeGraphExtractionContext,
  ) => Effect.Effect<CodeGraphFileFacts, CodeGraphLanguagePackError, TreeSitterRuntime>;
}

export interface CodeGraphLanguagePack {
  readonly assets: readonly VerifiedLanguageAsset[];
  readonly capabilities: ReadonlySet<CodeGraphCapability>;
  readonly extractor: CodeGraphExtractor;
  readonly files: readonly CodeGraphFileMatcher[];
  readonly id: string;
  readonly resolutionStrategy: CodeGraphResolutionStrategy;
  readonly version: string;
  readonly workspaceDetector: Option.Option<CodeGraphWorkspaceDetector>;
}

export interface CodeGraphLanguageMatch {
  readonly cacheIdentity: string;
  readonly language: string;
  readonly pack: CodeGraphLanguagePack;
  readonly role: CodeGraphFileRole;
}

export class CodeGraphLanguagePackError extends Error {
  override readonly name = 'CodeGraphLanguagePackError';
}
