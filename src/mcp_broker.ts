import type {StandaloneActiveRelease} from './standalone_process_lease.js';

const MCP_BROKER_MAX_LINE_BYTES = 32 * 1024 * 1024;
const MCP_BROKER_REPLAY_TIMEOUT_MILLISECONDS = 10_000;
const MCP_BROKER_CHILD_STOP_WAIT_MILLISECONDS = 1_000;
const MCP_BROKER_RUNTIME_EXIT_ERROR =
  'Threadnote MCP runtime exited before responding. The request outcome is unknown; inspect state before retrying a mutating operation.';

export class McpBrokerError extends Error {
  readonly _tag = 'McpBrokerError' as const;
}

interface McpBrokerChildInput {
  end(): Promise<unknown> | unknown;
  flush(): Promise<unknown> | unknown;
  write(value: string): number | Promise<number>;
}

export interface McpBrokerChild {
  readonly exited: Promise<number>;
  readonly input: McpBrokerChildInput;
  kill(signal?: number | NodeJS.Signals): void;
  readonly output: AsyncIterable<Uint8Array>;
  readonly processId: number;
}

export interface McpBrokerDependencies {
  readonly input: AsyncIterable<Uint8Array>;
  readonly readActiveRelease: () => Promise<StandaloneActiveRelease | undefined>;
  readonly spawn: (release: StandaloneActiveRelease) => McpBrokerChild;
  readonly writeOutput: (line: string) => Promise<void>;
}

interface JsonRpcEnvelope {
  readonly error?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly result?: unknown;
}

interface ActiveBrokerChild {
  readonly child: McpBrokerChild;
  readonly release: StandaloneActiveRelease;
  replay?: {
    readonly idKey: string;
    readonly reject: (cause: unknown) => void;
    readonly resolve: () => void;
  };
}

/**
 * Keeps the editor-owned stdio transport stable while versioned MCP runtimes
 * are promoted behind it. Requests already admitted by the old runtime are
 * allowed to finish; the next request starts the active release and replays the
 * MCP initialization handshake before forwarding new work.
 */
export async function runMcpBroker(dependencies: McpBrokerDependencies): Promise<void> {
  const broker = new McpBroker(dependencies);
  await broker.run();
}

class McpBroker {
  readonly #clientRequests = new Map<string, string | number>();
  readonly #dependencies: McpBrokerDependencies;
  readonly #serverRequests = new Set<string>();
  #child: ActiveBrokerChild | undefined;
  #initializeLine: string | undefined;
  #initializeRequestId: string | number | undefined;
  #initializedLine: string | undefined;
  #outputTail = Promise.resolve();

  constructor(dependencies: McpBrokerDependencies) {
    this.#dependencies = dependencies;
  }

  async run(): Promise<void> {
    try {
      for await (const line of ndjsonLines(this.#dependencies.input)) {
        await this.#handleClientLine(line);
      }
    } finally {
      await this.#stopCurrentChild();
      await this.#outputTail.catch(() => undefined);
    }
  }

  async #handleClientLine(line: string): Promise<void> {
    const envelope = parseJsonRpcEnvelope(line);
    const current = await this.#ensureCurrentChild();
    if (envelope?.method === 'initialize' && isJsonRpcId(envelope.id)) {
      this.#initializeLine = line;
      this.#initializeRequestId = envelope.id;
    } else if (envelope?.method === 'notifications/initialized') {
      this.#initializedLine = line;
    }
    if (envelope?.method !== undefined && isJsonRpcId(envelope.id)) {
      this.#clientRequests.set(jsonRpcIdKey(envelope.id), envelope.id);
    } else if (envelope?.method === undefined && isJsonRpcId(envelope?.id)) {
      this.#serverRequests.delete(jsonRpcIdKey(envelope.id));
    }
    await writeChildLine(current.child, line);
  }

  async #ensureCurrentChild(): Promise<ActiveBrokerChild> {
    const active = await this.#dependencies.readActiveRelease();
    if (active === undefined) {
      if (this.#child !== undefined) return this.#child;
      throw new McpBrokerError('Threadnote has no valid active standalone release for the MCP broker.');
    }
    if (
      this.#child !== undefined &&
      this.#child.release.version === active.version &&
      this.#child.release.releaseRoot === active.releaseRoot
    ) {
      return this.#child;
    }
    if (this.#child !== undefined && (this.#clientRequests.size > 0 || this.#serverRequests.size > 0)) {
      return this.#child;
    }
    await this.#stopCurrentChild();
    const next = this.#startChild(active);
    if (this.#initializeLine !== undefined && this.#initializeRequestId !== undefined) {
      await this.#replayInitialization(next);
    }
    return next;
  }

  #startChild(release: StandaloneActiveRelease): ActiveBrokerChild {
    const active = {child: this.#dependencies.spawn(release), release} satisfies ActiveBrokerChild;
    this.#child = active;
    void this.#observeChild(active);
    return active;
  }

  async #observeChild(active: ActiveBrokerChild): Promise<void> {
    await Promise.all([this.#readChildOutput(active), active.child.exited.catch(() => -1)]).catch(() => undefined);
    if (this.#child !== active) return;
    this.#child = undefined;
    active.replay?.reject(new McpBrokerError('Threadnote MCP runtime exited during session promotion.'));
    active.replay = undefined;
    const pending = [...this.#clientRequests.values()];
    this.#clientRequests.clear();
    this.#serverRequests.clear();
    for (const id of pending) {
      await this.#queueOutput(
        JSON.stringify({
          error: {code: -32_603, message: MCP_BROKER_RUNTIME_EXIT_ERROR},
          id,
          jsonrpc: '2.0',
        }),
      );
    }
  }

  async #readChildOutput(active: ActiveBrokerChild): Promise<void> {
    for await (const line of ndjsonLines(active.child.output)) {
      if (this.#child !== active) continue;
      const envelope = parseJsonRpcEnvelope(line);
      if (isJsonRpcId(envelope?.id)) {
        const idKey = jsonRpcIdKey(envelope.id);
        if (active.replay?.idKey === idKey && envelope?.method === undefined) {
          const replay = active.replay;
          active.replay = undefined;
          if (envelope.error === undefined && envelope.result !== undefined) replay.resolve();
          else replay.reject(new McpBrokerError('The promoted MCP runtime rejected the replayed initialization.'));
          continue;
        }
        if (envelope?.method === undefined) this.#clientRequests.delete(idKey);
        else this.#serverRequests.add(idKey);
      }
      await this.#queueOutput(line);
    }
  }

  async #replayInitialization(active: ActiveBrokerChild): Promise<void> {
    const initializeLine = this.#initializeLine;
    const initializeRequestId = this.#initializeRequestId;
    if (initializeLine === undefined || initializeRequestId === undefined) return;
    const replayed = new Promise<void>((resolve, reject) => {
      active.replay = {idKey: jsonRpcIdKey(initializeRequestId), reject, resolve};
    });
    await writeChildLine(active.child, initializeLine);
    await Promise.race([
      replayed,
      Bun.sleep(MCP_BROKER_REPLAY_TIMEOUT_MILLISECONDS).then(() => {
        throw new McpBrokerError('Timed out initializing the promoted Threadnote MCP runtime.');
      }),
    ]);
    if (this.#initializedLine !== undefined) await writeChildLine(active.child, this.#initializedLine);
  }

  async #stopCurrentChild(): Promise<void> {
    const active = this.#child;
    if (active === undefined) return;
    this.#child = undefined;
    active.replay?.reject(new McpBrokerError('Threadnote MCP runtime promotion was superseded.'));
    active.replay = undefined;
    await Promise.resolve(active.child.input.end()).catch(() => undefined);
    if (await exitsWithin(active.child, MCP_BROKER_CHILD_STOP_WAIT_MILLISECONDS)) return;
    try {
      active.child.kill('SIGTERM');
    } catch {
      // The child can exit between the bounded wait and the signal.
    }
    if (await exitsWithin(active.child, MCP_BROKER_CHILD_STOP_WAIT_MILLISECONDS)) return;
    try {
      active.child.kill('SIGKILL');
    } catch {
      // The child already exited.
    }
    await exitsWithin(active.child, MCP_BROKER_CHILD_STOP_WAIT_MILLISECONDS);
  }

  #queueOutput(line: string): Promise<void> {
    const write = this.#outputTail.then(() => this.#dependencies.writeOutput(line));
    this.#outputTail = write.catch(() => undefined);
    return write;
  }
}

async function writeChildLine(child: McpBrokerChild, line: string): Promise<void> {
  await child.input.write(`${line}\n`);
  await child.input.flush();
}

async function exitsWithin(child: McpBrokerChild, timeoutMilliseconds: number): Promise<boolean> {
  return Promise.race([
    child.exited.then(() => true).catch(() => true),
    Bun.sleep(timeoutMilliseconds).then(() => false),
  ]);
}

async function* ndjsonLines(input: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of input) {
    buffered += decoder.decode(chunk, {stream: true});
    if (new TextEncoder().encode(buffered).byteLength > MCP_BROKER_MAX_LINE_BYTES) {
      throw new McpBrokerError('Threadnote MCP broker received an oversized protocol line.');
    }
    for (;;) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline).replace(/\r$/u, '');
      buffered = buffered.slice(newline + 1);
      if (line.length > 0) yield line;
    }
  }
  buffered += decoder.decode();
  const line = buffered.replace(/\r$/u, '');
  if (line.length > 0) yield line;
}

function parseJsonRpcEnvelope(line: string): JsonRpcEnvelope | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRpcEnvelope) : undefined;
  } catch {
    return undefined;
  }
}

function isJsonRpcId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function jsonRpcIdKey(value: string | number): string {
  return `${typeof value}:${String(value)}`;
}
