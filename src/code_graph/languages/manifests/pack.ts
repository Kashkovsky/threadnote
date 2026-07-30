import {Effect, Option} from 'effect';
import {sha256HexSync} from '../../../crypto/sha256.js';
import {extractFileFacts} from '../../extractor.js';
import {manifestWorkspaceDetector} from '../../workspace.js';
import {CodeGraphLanguagePackError, type CodeGraphLanguagePack} from '../types.js';

export const codeGraphLanguagePack: CodeGraphLanguagePack = {
  assets: [],
  capabilities: new Set(['declarations', 'dependencies', 'workspace']),
  extractor: {
    extract: file =>
      Effect.try({
        try: () => extractFileFacts(file),
        catch: cause => new CodeGraphLanguagePackError(`Could not extract manifest facts from ${file.path}.`, {cause}),
      }),
    version: sha256HexSync('threadnote-manifest-extractors-v2'),
  },
  files: [
    {kind: 'basename', language: 'npm-manifest', role: 'manifest', value: 'package.json'},
    {kind: 'basename', language: 'typescript-config', role: 'workspace', value: 'tsconfig.json'},
    {kind: 'basename', language: 'go-manifest', role: 'manifest', value: 'go.mod'},
    {kind: 'basename', language: 'maven-manifest', role: 'manifest', value: 'pom.xml'},
    {kind: 'basename', language: 'gradle-manifest', role: 'workspace', value: 'settings.gradle'},
    {kind: 'basename', language: 'gradle-manifest', role: 'workspace', value: 'settings.gradle.kts'},
    {kind: 'basename', language: 'gradle-manifest', role: 'manifest', value: 'build.gradle'},
    {kind: 'basename', language: 'gradle-manifest', role: 'manifest', value: 'build.gradle.kts'},
    {kind: 'basename', language: 'gradle-manifest', role: 'workspace', value: 'gradle.properties'},
    {kind: 'basename', language: 'swift-package-manifest', role: 'workspace', value: 'package.swift'},
    {
      kind: 'path-suffix',
      language: 'xcode-project',
      role: 'workspace',
      value: '.xcodeproj/project.pbxproj',
    },
  ],
  id: 'manifests',
  resolutionStrategy: {domain: 'workspace', version: 'static-manifests-v1'},
  version: '1.0.0',
  workspaceDetector: Option.some(manifestWorkspaceDetector),
};
