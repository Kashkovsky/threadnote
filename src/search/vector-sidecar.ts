import {Schema} from 'effect';

const MAGIC = new TextEncoder().encode('TNVECTR1');
const PREFIX_BYTES = 8 + 2 + 4 + 4 + 4;
export const VECTOR_SIDECAR_VERSION = 1 as const;

export interface VectorSidecarEntry {
  readonly fingerprint: string;
  readonly id: string;
  readonly uri: string;
  readonly vector: readonly number[];
}

export interface VectorSidecarMetadata {
  readonly chunkerVersion: number;
  readonly dimensions: number;
  readonly modelId: string;
  readonly modelSha256: string;
  readonly normalized: 'l2';
}

export interface VectorSidecar {
  readonly entries: readonly VectorSidecarEntry[];
  readonly metadata: VectorSidecarMetadata;
  readonly version: typeof VECTOR_SIDECAR_VERSION;
}

interface EncodedVectorSidecarHeader {
  readonly chunkerVersion: number;
  readonly count: number;
  readonly dimensions: number;
  readonly entries: readonly Omit<VectorSidecarEntry, 'vector'>[];
  readonly modelId: string;
  readonly modelSha256: string;
  readonly normalized: 'l2';
}

export class VectorSidecarInvalid extends Schema.TaggedErrorClass<VectorSidecarInvalid>()('VectorSidecarInvalid', {
  message: Schema.String,
}) {}

export function encodeVectorSidecar(sidecar: VectorSidecar): Uint8Array {
  validateMetadata(sidecar.metadata);
  const seen = new Set<string>();
  for (const entry of sidecar.entries) {
    if (!entry.id || seen.has(entry.id)) {
      throw new VectorSidecarInvalid({message: `Vector entry IDs must be non-empty and unique: ${entry.id}.`});
    }
    seen.add(entry.id);
    validateVector(entry.id, entry.vector, sidecar.metadata.dimensions);
  }
  const header: EncodedVectorSidecarHeader = {
    chunkerVersion: sidecar.metadata.chunkerVersion,
    count: sidecar.entries.length,
    dimensions: sidecar.metadata.dimensions,
    entries: sidecar.entries.map(({fingerprint, id, uri}) => ({fingerprint, id, uri})),
    modelId: sidecar.metadata.modelId,
    modelSha256: sidecar.metadata.modelSha256,
    normalized: sidecar.metadata.normalized,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const vectorBytes = sidecar.entries.length * sidecar.metadata.dimensions * 4;
  const output = new Uint8Array(PREFIX_BYTES + headerBytes.length + vectorBytes);
  output.set(MAGIC, 0);
  const view = new DataView(output.buffer);
  view.setUint16(8, VECTOR_SIDECAR_VERSION, true);
  view.setUint32(10, headerBytes.length, true);
  view.setUint32(14, vectorBytes, true);
  output.set(headerBytes, PREFIX_BYTES);
  let offset = PREFIX_BYTES + headerBytes.length;
  for (const entry of sidecar.entries) {
    for (const component of entry.vector) {
      view.setFloat32(offset, component, true);
      offset += 4;
    }
  }
  view.setUint32(18, crc32(output.subarray(PREFIX_BYTES)), true);
  return output;
}

export function decodeVectorSidecar(input: Uint8Array): VectorSidecar {
  try {
    if (input.length < PREFIX_BYTES || !MAGIC.every((value, index) => input[index] === value)) {
      throw new Error('Vector sidecar magic does not match.');
    }
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const version = view.getUint16(8, true);
    if (version !== VECTOR_SIDECAR_VERSION) {
      throw new Error(`Unsupported vector sidecar version: ${version}.`);
    }
    const headerLength = view.getUint32(10, true);
    const vectorBytes = view.getUint32(14, true);
    const expectedLength = PREFIX_BYTES + headerLength + vectorBytes;
    if (input.length !== expectedLength) {
      throw new Error(`Vector sidecar length is ${input.length}; expected ${expectedLength}.`);
    }
    const expectedCrc = view.getUint32(18, true);
    const actualCrc = crc32(input.subarray(PREFIX_BYTES));
    if (expectedCrc !== actualCrc) {
      throw new Error('Vector sidecar checksum does not match.');
    }
    const header = JSON.parse(
      new TextDecoder('utf-8', {fatal: true}).decode(input.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength)),
    ) as unknown;
    assertHeader(header);
    if (vectorBytes !== header.count * header.dimensions * 4) {
      throw new Error('Vector sidecar payload size does not match its count and dimensions.');
    }
    const metadata: VectorSidecarMetadata = {
      chunkerVersion: header.chunkerVersion,
      dimensions: header.dimensions,
      modelId: header.modelId,
      modelSha256: header.modelSha256,
      normalized: header.normalized,
    };
    validateMetadata(metadata);
    let offset = PREFIX_BYTES + headerLength;
    const entries = header.entries.map(entry => {
      const vector = new Array<number>(header.dimensions);
      for (let index = 0; index < header.dimensions; index += 1) {
        vector[index] = view.getFloat32(offset, true);
        offset += 4;
      }
      validateVector(entry.id, vector, header.dimensions);
      return {...entry, vector};
    });
    return {entries, metadata, version: VECTOR_SIDECAR_VERSION};
  } catch (cause) {
    if (cause instanceof VectorSidecarInvalid) throw cause;
    throw new VectorSidecarInvalid({message: cause instanceof Error ? cause.message : String(cause)});
  }
}

function assertHeader(value: unknown): asserts value is EncodedVectorSidecarHeader {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Vector sidecar header is not an object.');
  }
  const header = value as Partial<EncodedVectorSidecarHeader>;
  if (
    !Number.isInteger(header.chunkerVersion) ||
    !Number.isInteger(header.count) ||
    !Number.isInteger(header.dimensions) ||
    typeof header.modelId !== 'string' ||
    typeof header.modelSha256 !== 'string' ||
    header.normalized !== 'l2' ||
    !Array.isArray(header.entries) ||
    header.entries.length !== header.count ||
    header.entries.some(
      entry =>
        typeof entry !== 'object' ||
        entry === null ||
        typeof entry.id !== 'string' ||
        typeof entry.uri !== 'string' ||
        typeof entry.fingerprint !== 'string',
    )
  ) {
    throw new Error('Vector sidecar header is invalid.');
  }
}

function validateMetadata(metadata: VectorSidecarMetadata): void {
  if (
    !Number.isInteger(metadata.chunkerVersion) ||
    metadata.chunkerVersion <= 0 ||
    !Number.isInteger(metadata.dimensions) ||
    metadata.dimensions <= 0 ||
    !metadata.modelId ||
    !/^[0-9a-f]{64}$/.test(metadata.modelSha256) ||
    metadata.normalized !== 'l2'
  ) {
    throw new VectorSidecarInvalid({message: 'Vector sidecar metadata is invalid.'});
  }
}

function validateVector(id: string, vector: readonly number[], dimensions: number): void {
  if (vector.length !== dimensions || vector.some(component => !Number.isFinite(component))) {
    throw new VectorSidecarInvalid({
      message: `Vector ${id} must contain exactly ${dimensions} finite components.`,
    });
  }
  const magnitude = Math.sqrt(vector.reduce((sum, component) => sum + component * component, 0));
  if (Math.abs(magnitude - 1) > 0.001) {
    throw new VectorSidecarInvalid({message: `Vector ${id} is not L2-normalized.`});
  }
}

function crc32(input: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
