import type {VerifiedLanguageAsset} from './types.js';

export const JAVA_GRAMMAR: VerifiedLanguageAsset = {
  abi: 14,
  relativePath: 'grammars/java.wasm',
  sha256: '4fdeac4ca6ca089f06c6f7e562abcac1733cd465728cc7031ebb73c2019122c4',
  source: 'tree-sitter-java@94703d5a6bed02b98e438d7cad1136c01a60ba2c',
  version: '0.23.5',
};

export const KOTLIN_GRAMMAR: VerifiedLanguageAsset = {
  abi: 15,
  relativePath: 'grammars/kotlin.wasm',
  sha256: 'ba42b78e5c676ba4e4fdf845e8c6510c04bebdf1a0f8d324c764986acb1a890d',
  source: 'tree-sitter-kotlin@c8ac3d2627240160b999a2c100de3babbdb8f419',
  version: '0.3.8+threadnote.c8ac3d2',
};

export const SWIFT_GRAMMAR: VerifiedLanguageAsset = {
  abi: 15,
  relativePath: 'grammars/swift.wasm',
  sha256: 'c35b839e49158cc485459f149efc6e113546f367ff3154895e1c993080e1ed38',
  source: 'tree-sitter-swift@31d17fe7e818a2048c808b5c6fdc2dc792f4f5b5',
  version: '0.7.3',
};
