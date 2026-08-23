import type {CodeGraphMaterializationSubphaseMilliseconds} from './types.js';

type MaterializationSubphase = keyof CodeGraphMaterializationSubphaseMilliseconds;
type MutableMaterializationSubphases = {-readonly [Key in MaterializationSubphase]: number};

export class MaterializationSubphaseTiming {
  readonly #now: () => number;
  readonly #milliseconds: MutableMaterializationSubphases = {
    attributionCompute: 0,
    factBatchPreparation: 0,
    shardAssociation: 0,
    shardPersistence: 0,
    shardSerialization: 0,
  };

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  add(subphase: MaterializationSubphase, milliseconds: number): void {
    this.#milliseconds[subphase] += Math.max(0, milliseconds);
  }

  measure<Value>(subphase: MaterializationSubphase, operation: () => Value): Value {
    const startedAt = this.#now();
    const value = operation();
    this.add(subphase, this.#now() - startedAt);
    return value;
  }

  measureExcluding<Value>(
    subphase: MaterializationSubphase,
    excluded: MaterializationSubphase,
    operation: () => Value,
  ): Value {
    const excludedBefore = this.#milliseconds[excluded];
    const startedAt = this.#now();
    const value = operation();
    this.add(subphase, this.#now() - startedAt - (this.#milliseconds[excluded] - excludedBefore));
    return value;
  }

  snapshot(): CodeGraphMaterializationSubphaseMilliseconds {
    return {...this.#milliseconds};
  }
}
