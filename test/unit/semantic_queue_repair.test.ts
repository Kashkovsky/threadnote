import {describe, expect, it} from 'vitest';
import {patchSemanticProcessorSource} from '../../src/semantic_queue_repair.js';

// Minimal stand-in for OpenViking's _process_memory_directory: the outer try,
// the inner try wrapping ls(dir_uri), and the _mark_done helper the guard calls.
const SAMPLE = [
  'class SemanticProcessor:',
  '    async def _process_memory_directory(self, msg, ctx=None):',
  '        viking_fs = get_viking_fs()',
  '        dir_uri = msg.uri',
  '',
  '        def _mark_done():',
  '            pass',
  '',
  '        try:',
  '            try:',
  '                entries = await viking_fs.ls(dir_uri, node_limit=LS_ALL_NODES, ctx=ctx)',
  '            except Exception as e:',
  '                raise RuntimeError(f"Failed to list memory directory {dir_uri}: {e}") from e',
  '            for entry in entries:',
  '                pass',
  '        finally:',
  '            await lock.close()',
  '',
].join('\n');

describe('patchSemanticProcessorSource', () => {
  it('inserts the guard, at the right indent, before the ls(dir_uri) call', () => {
    const result = patchSemanticProcessorSource(SAMPLE);
    expect(result.status).toBe('patched');
    if (result.status !== 'patched') {
      return;
    }
    const src = result.source;
    expect(src).toContain('THREADNOTE-HOTFIX-2734');
    expect(src.indexOf('_tn_dir_stat = await viking_fs.stat(dir_uri')).toBeLessThan(
      src.indexOf('entries = await viking_fs.ls(dir_uri'),
    );
    // guard `try:` at the inner-try indent (12), stat one level deeper (16)
    expect(src).toContain('\n            try:\n                _tn_dir_stat = await viking_fs.stat(dir_uri, ctx=ctx)');
    // original ls line is preserved untouched
    expect(src).toContain('                entries = await viking_fs.ls(dir_uri, node_limit=LS_ALL_NODES, ctx=ctx)');
  });

  it('is idempotent: re-patching detects the marker', () => {
    const once = patchSemanticProcessorSource(SAMPLE);
    expect(once.status).toBe('patched');
    if (once.status !== 'patched') {
      return;
    }
    expect(patchSemanticProcessorSource(once.source).status).toBe('already-fixed');
  });

  it('treats an existing stat(dir_uri) guard (upstream fix) as already-fixed', () => {
    const upstream = SAMPLE.replace(
      '        try:\n            try:',
      '        try:\n            dir_stat = await viking_fs.stat(dir_uri, ctx=ctx)\n            try:',
    );
    expect(patchSemanticProcessorSource(upstream).status).toBe('already-fixed');
  });

  it('returns no-anchor when the ls(dir_uri) call is absent', () => {
    const noLs = SAMPLE.replace(
      'entries = await viking_fs.ls(dir_uri, node_limit=LS_ALL_NODES, ctx=ctx)',
      'entries = []',
    );
    expect(patchSemanticProcessorSource(noLs).status).toBe('no-anchor');
  });

  it('returns no-anchor when _process_memory_directory is absent', () => {
    expect(patchSemanticProcessorSource('class Foo:\n    pass\n').status).toBe('no-anchor');
  });
});
