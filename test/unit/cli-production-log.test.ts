import {describe, expect, it} from 'vitest';
import {inspectCliInvocation} from '../../src/effect/cli.js';

describe('CLI production log policy', () => {
  it('uses the registered canonical command names and aliases', () => {
    expect(inspectCliInvocation(['init-manifest'])).toMatchObject({
      operation: 'init-manifest',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['install-hooks', '--apply'])).toMatchObject({
      operation: 'install-hooks',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['pre-compact-hook'])).toMatchObject({
      operation: 'pre-compact-hook',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['session-start-hook'])).toMatchObject({
      operation: 'session-start-hook',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['ls'])).toMatchObject({operation: 'list', writeProductionLog: true});
  });

  it('does not log explicit or implicit preview operations', () => {
    expect(inspectCliInvocation(['remember', '--dry-run', '--text', 'preview'])).toMatchObject({
      operation: 'remember',
      writeProductionLog: false,
    });
    expect(inspectCliInvocation(['source', 'add', '--id', 'docs'])).toMatchObject({
      operation: 'source',
      writeProductionLog: false,
    });
    expect(inspectCliInvocation(['source', 'add', '--id', 'docs', '--apply'])).toMatchObject({
      operation: 'source',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['report-issue', '--apply'])).toMatchObject({
      operation: 'report-issue',
      writeProductionLog: false,
    });
    expect(inspectCliInvocation(['migrate-memories'])).toMatchObject({
      operation: 'migrate-memories',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['migrate-lifecycle'])).toMatchObject({
      operation: 'migrate-lifecycle',
      writeProductionLog: false,
    });
    for (const command of ['publish', 'publish-artifact', 'publish-bundle']) {
      expect(inspectCliInvocation(['share', command, '--preview'])).toMatchObject({
        operation: 'share',
        writeProductionLog: false,
      });
      expect(inspectCliInvocation(['share', command, '--preview=false'])).toMatchObject({
        operation: 'share',
        writeProductionLog: true,
      });
    }
  });

  it('uses effective boolean values for logging policy', () => {
    for (const falseValue of ['false', 'no', 'off', '0']) {
      expect(inspectCliInvocation(['remember', `--dry-run=${falseValue}`])).toMatchObject({
        writeProductionLog: true,
      });
      expect(inspectCliInvocation(['source', 'add', '--apply', falseValue])).toMatchObject({
        writeProductionLog: false,
      });
    }
    for (const trueValue of ['true', 'yes', 'on', '1']) {
      expect(inspectCliInvocation(['remember', '--dry-run', trueValue])).toMatchObject({
        writeProductionLog: false,
      });
      expect(inspectCliInvocation(['source', 'add', `--apply=${trueValue}`])).toMatchObject({
        writeProductionLog: true,
      });
    }
  });

  it('does not mistake dash-prefixed string values for policy flags', () => {
    expect(
      inspectCliInvocation([
        '--log-level',
        'info',
        '--home',
        '/tmp/threadnote-test',
        'remember',
        '--text',
        '--dry-run',
      ]),
    ).toEqual({
      homeOverride: '/tmp/threadnote-test',
      operation: 'remember',
      writeProductionLog: true,
    });
    expect(inspectCliInvocation(['remember', '--text', '--help'])).toMatchObject({
      operation: 'remember',
      writeProductionLog: true,
    });
  });
});
