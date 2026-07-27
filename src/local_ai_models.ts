export interface LocalAiModelDefinition {
  readonly aliases: readonly string[];
  readonly description: string;
  readonly displayName: string;
  readonly file: string;
  readonly id: string;
  readonly repository: string;
  readonly revision: string;
  readonly sha256: string;
  readonly size: number;
}

export const LOCAL_AI_MODELS: readonly LocalAiModelDefinition[] = [
  {
    aliases: ['gemma-4-e4b-it', 'gemma-4-e4b-it-q4_0', 'ggml-org/gemma-4-E4B-it-GGUF'],
    description: 'Recommended higher-quality local recall model',
    displayName: 'Gemma 4 E4B IT (Q4_0)',
    file: 'gemma-4-E4B-it-Q4_0.gguf',
    id: 'gemma-4-E4B-it-Q4_0',
    repository: 'ggml-org/gemma-4-E4B-it-GGUF',
    revision: '06f24bb269339b2a19a5167199b81e89ef813c10',
    sha256: 'a555b900214b477d8880e7832e0b8925e139b0159640036b09fe472b6f2097f2',
    size: 4_590_807_392,
  },
  {
    aliases: ['lfm2.5-350m', 'liquidai/lfm2.5-350m', 'liquidai/lfm2.5-350m-gguf', 'lfm2.5-350m-q4_k_m'],
    description: 'Compact, fast model for constrained local hardware',
    displayName: 'LFM2.5 350M (Q4_K_M)',
    file: 'LFM2.5-350M-Q4_K_M.gguf',
    id: 'LFM2.5-350M',
    repository: 'LiquidAI/LFM2.5-350M-GGUF',
    revision: 'bb7ee58b243e4cede04187e323e760b04f8a0091',
    sha256: '7e6f72643caafc9a68256686638c4d7916f2cec76d1df478d4c3ddcd95a6aed4',
    size: 229_312_224,
  },
];

export const DEFAULT_LOCAL_AI_MODEL = LOCAL_AI_MODELS[0]!;

export function findLocalAiModel(requested: string | undefined): LocalAiModelDefinition | undefined {
  if (requested === undefined || requested.trim().length === 0) {
    return DEFAULT_LOCAL_AI_MODEL;
  }
  const normalized = requested.trim().toLowerCase();
  return LOCAL_AI_MODELS.find(
    model => model.id.toLowerCase() === normalized || model.aliases.some(alias => alias.toLowerCase() === normalized),
  );
}

export function requireLocalAiModel(requested: string | undefined): LocalAiModelDefinition {
  const model = findLocalAiModel(requested);
  if (model) {
    return model;
  }
  throw new Error(
    `Unknown local AI model "${requested?.trim()}". Available models: ${LOCAL_AI_MODELS.map(item => item.id).join(', ')}.`,
  );
}
