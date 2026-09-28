import type {DeferredCodeAnchorWriteRequest} from '../deferred/code_anchor.js';

export function deferredCodeAnchorStoredMessage(memoryUri: string, request: DeferredCodeAnchorWriteRequest): string {
  const preparation = request.recovery.preparation;
  const prepare =
    preparation.target === 'callerCwd'
      ? `Run \`${preparation.command}\` from the cited repository.`
      : `Run \`${preparation.command} ${preparation.arguments[0]}\`.`;
  return [
    `Stored memory without finalized code citations: ${memoryUri}`,
    `${request.codeRefs.length} code reference(s) are pending in the private local outbox.`,
    prepare,
    preparation.target === 'callerCwd'
      ? 'Threadnote retries automatically after graph indexing and on the next code-linked Context Brief.'
      : 'Threadnote retries automatically after Workset preparation.',
    'If the intent remains pending, run `threadnote finalize-code-refs` as a repair fallback.',
  ].join(' ');
}
