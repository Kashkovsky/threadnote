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

export const PYTHON_GRAMMAR: VerifiedLanguageAsset = {
  abi: 15,
  developmentRelativePath: 'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm',
  relativePath: 'grammars/python.wasm',
  sha256: '16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47',
  source: 'tree-sitter-python@0.25.0 via @vscode/tree-sitter-wasm@0.3.1',
  version: '0.25.0+vscode.0.3.1',
};

export const GO_GRAMMAR: VerifiedLanguageAsset = {
  abi: 15,
  developmentRelativePath: 'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm',
  relativePath: 'grammars/go.wasm',
  sha256: '9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7',
  source: 'tree-sitter-go@0.25.0 via @vscode/tree-sitter-wasm@0.3.1',
  version: '0.25.0+vscode.0.3.1',
};

export const RUST_GRAMMAR: VerifiedLanguageAsset = {
  abi: 15,
  developmentRelativePath: 'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm',
  relativePath: 'grammars/rust.wasm',
  sha256: '0dac14947cb04d94466e3df659f80a4e264c216a60b3eda175eae4cf12ed7a8d',
  source: 'tree-sitter-rust@261b20226c04ef601adbdf185a800512a5f66291 via @vscode/tree-sitter-wasm@0.3.1',
  version: '0.24.0+vscode.261b202',
};

export const C_GRAMMAR: VerifiedLanguageAsset = {
  abi: 15,
  developmentRelativePath: 'node_modules/@repomix/tree-sitter-wasms/out/tree-sitter-c.wasm',
  relativePath: 'grammars/c.wasm',
  sha256: 'f0c308e7465d6af2e1de71426afbcb22ba33390227db950652808d248da03bf3',
  source: 'tree-sitter-c@0.24.1 via @repomix/tree-sitter-wasms@0.1.17',
  version: '0.24.1+repomix.0.1.17',
};

export const CPP_GRAMMAR: VerifiedLanguageAsset = {
  abi: 14,
  developmentRelativePath: 'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-cpp.wasm',
  relativePath: 'grammars/cpp.wasm',
  sha256: '77a65bd42f43c2dcd69af40c12a6c32d6ed81d360c025e9feb28911f8339fd69',
  source: 'tree-sitter-cpp@12bd6f7e96080d2e70ec51d4068f2f66120dde35 via @vscode/tree-sitter-wasm@0.3.1',
  version: '0.23.4+vscode.12bd6f7',
};

export const CSHARP_GRAMMAR: VerifiedLanguageAsset = {
  abi: 15,
  developmentRelativePath: 'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm',
  relativePath: 'grammars/csharp.wasm',
  sha256: 'd12d85996c25957b4c1b71e26db2d7cc8a294997b60642e9c2a3b031b2c66dd3',
  source: 'tree-sitter-c-sharp@485f0bae0274ac9114797fc10db6f7034e4086e3 via @vscode/tree-sitter-wasm@0.3.1',
  version: '0.23.1+vscode.485f0ba',
};

export const RUBY_GRAMMAR: VerifiedLanguageAsset = {
  abi: 14,
  developmentRelativePath: 'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-ruby.wasm',
  relativePath: 'grammars/ruby.wasm',
  sha256: '09a96427d7c72f0613ed470cd9812223fc4a91d6a9c025c0235cc6bd59ff96f4',
  source: 'tree-sitter-ruby@0.23.1 via @vscode/tree-sitter-wasm@0.3.1',
  version: '0.23.1+vscode.0.3.1',
};

export const PHP_GRAMMAR: VerifiedLanguageAsset = {
  abi: 15,
  developmentRelativePath: 'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-php.wasm',
  relativePath: 'grammars/php.wasm',
  sha256: 'd4df6a6ff08c87c3ec4f9cbb785fe09998a0cb570e03f57d7b19b3acfb146aa7',
  source: 'tree-sitter-php@0.24.2 via @vscode/tree-sitter-wasm@0.3.1',
  version: '0.24.2+vscode.0.3.1',
};

export const BASH_GRAMMAR: VerifiedLanguageAsset = {
  abi: 15,
  developmentRelativePath: 'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-bash.wasm',
  relativePath: 'grammars/bash.wasm',
  sha256: 'a14e9ed880b2c3f16cd00c796c38d237a3e9b028bdec5b4315c76976e67b01ca',
  source: 'tree-sitter-bash@0.25.0 via @vscode/tree-sitter-wasm@0.3.1',
  version: '0.25.0+vscode.0.3.1',
};

export const HCL_GRAMMAR: VerifiedLanguageAsset = {
  abi: 14,
  developmentRelativePath: 'node_modules/@tree-sitter-grammars/tree-sitter-hcl/tree-sitter-hcl.wasm',
  relativePath: 'grammars/hcl.wasm',
  sha256: '86bb80cd151bd3ab1e44ed431a9c1874978db31519c62055efb50f028a1d0118',
  source: '@tree-sitter-grammars/tree-sitter-hcl@1.2.0',
  version: '1.2.0',
};

export const POWERSHELL_GRAMMAR: VerifiedLanguageAsset = {
  abi: 14,
  developmentRelativePath: 'node_modules/@vscode/tree-sitter-wasm/wasm/tree-sitter-powershell.wasm',
  relativePath: 'grammars/powershell.wasm',
  sha256: '55526edd3545fb7e78ff88c39dd617d8b3c03a1d1a88209fffe5c64c7c7c8500',
  source: 'tree-sitter-powershell@9379c77984af1f3d3d7e3cc5e897de3496725280 via @vscode/tree-sitter-wasm@0.3.1',
  version: '0.25.9+vscode.9379c77',
};

export const DART_GRAMMAR: VerifiedLanguageAsset = {
  abi: 15,
  developmentRelativePath: 'node_modules/@repomix/tree-sitter-wasms/out/tree-sitter-dart.wasm',
  relativePath: 'grammars/dart.wasm',
  sha256: '2346f891b73e741b35d33be6cc450ec6b471cf42e80515182f8fa89dc479fd69',
  source: 'tree-sitter-dart@0fc19c3a57b1109802af41d2b8f60d8835c5da3a via @repomix/tree-sitter-wasms@0.1.17',
  version: '1.0.0+repomix.0fc19c3',
};

export const SOLIDITY_GRAMMAR: VerifiedLanguageAsset = {
  abi: 15,
  developmentRelativePath: 'node_modules/@repomix/tree-sitter-wasms/out/tree-sitter-solidity.wasm',
  relativePath: 'grammars/solidity.wasm',
  sha256: 'd6828119e6099d23a783c0e5486354b41523dfe4a1df5b3bc2b66105c3272d7f',
  source: 'tree-sitter-solidity@4e938a46c7030dd001bc99e1ac0f0c750ac98254 via @repomix/tree-sitter-wasms@0.1.17',
  version: '1.2.13+repomix.4e938a4',
};

export const VUE_GRAMMAR: VerifiedLanguageAsset = {
  abi: 15,
  developmentRelativePath: 'node_modules/@repomix/tree-sitter-wasms/out/tree-sitter-vue.wasm',
  relativePath: 'grammars/vue.wasm',
  sha256: '8c6d964ca8830b644d14e173f7b0f2d4d9dbcac1c4bdad0e0df2b799a1b58150',
  source: 'tree-sitter-vue@22bdfa6c9fc0f5ffa44c6e938ec46869ac8a99ff via @repomix/tree-sitter-wasms@0.1.17',
  version: '0.1.0+repomix.22bdfa6',
};

export const LUA_GRAMMAR: VerifiedLanguageAsset = {
  abi: 15,
  developmentRelativePath: 'node_modules/@tree-sitter-grammars/tree-sitter-lua/tree-sitter-lua.wasm',
  relativePath: 'grammars/lua.wasm',
  sha256: '6d95607fc7d78964cfdf065ccb1ba76be5ed217c5ec0d0a3cace13c59fa1ae43',
  source: '@tree-sitter-grammars/tree-sitter-lua@0.4.1',
  version: '0.4.1',
};

export const SCALA_GRAMMAR: VerifiedLanguageAsset = {
  abi: 14,
  developmentRelativePath: 'node_modules/tree-sitter-scala/tree-sitter-scala.wasm',
  relativePath: 'grammars/scala.wasm',
  sha256: 'b7ec2bb29c19827abcefd18ed5cb5a43596009f96a5d53c5b9d1f9676d7521c3',
  source: 'tree-sitter-scala@0.24.0',
  version: '0.24.0',
};

export const ELIXIR_GRAMMAR: VerifiedLanguageAsset = {
  abi: 14,
  developmentRelativePath: 'node_modules/tree-sitter-elixir/tree-sitter-elixir.wasm',
  relativePath: 'grammars/elixir.wasm',
  sha256: 'ed99093c548c12d43f7e337fd3440e9e2daa2ec671a5e29aadb6c6dcb2232a62',
  source: 'tree-sitter-elixir@0.3.5',
  version: '0.3.5',
};

export const ZIG_GRAMMAR: VerifiedLanguageAsset = {
  abi: 14,
  developmentRelativePath: 'node_modules/@tree-sitter-grammars/tree-sitter-zig/tree-sitter-zig.wasm',
  relativePath: 'grammars/zig.wasm',
  sha256: '54b3b83dd9c62da5815f06132bc3fc914d9dcc780370b32416446a0b7969e8c6',
  source: '@tree-sitter-grammars/tree-sitter-zig@1.1.2',
  version: '1.1.2',
};

export const JULIA_GRAMMAR: VerifiedLanguageAsset = {
  abi: 14,
  developmentRelativePath: 'node_modules/tree-sitter-julia/tree-sitter-julia.wasm',
  relativePath: 'grammars/julia.wasm',
  sha256: 'e0f52c36eadf0299e46fccd6715c760d35eaa3f09721bec38633da551ac9e781',
  source: 'tree-sitter-julia@0.23.1',
  version: '0.23.1',
};

export const OBJC_GRAMMAR: VerifiedLanguageAsset = {
  abi: 14,
  developmentRelativePath: 'node_modules/tree-sitter-objc/tree-sitter-objc.wasm',
  relativePath: 'grammars/objc.wasm',
  sha256: '155bf61fc94941fa9d07c86cd46895f14dfb2549fb7f646faeb83765af05c970',
  source: 'tree-sitter-objc@3.0.2',
  version: '3.0.2',
};

export const SVELTE_GRAMMAR: VerifiedLanguageAsset = {
  abi: 14,
  developmentRelativePath: 'node_modules/@tree-sitter-grammars/tree-sitter-svelte/tree-sitter-svelte.wasm',
  relativePath: 'grammars/svelte.wasm',
  sha256: 'f236de0e48f2d708e9f26895fbb64feea20ee087d64c9e5538078245275f0758',
  source: '@tree-sitter-grammars/tree-sitter-svelte@1.0.2',
  version: '1.0.2',
};

export const SYSTEMVERILOG_GRAMMAR: VerifiedLanguageAsset = {
  abi: 15,
  developmentRelativePath: 'node_modules/tree-sitter-systemverilog/tree-sitter-systemverilog.wasm',
  relativePath: 'grammars/systemverilog.wasm',
  sha256: 'e193719c5f0406e87be1ec1d7977f19aae39cf14fabc1d2c7b1e50b4e467a87d',
  source: 'tree-sitter-systemverilog@0.4.0',
  version: '0.4.0',
};
