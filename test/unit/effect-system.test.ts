import {describe, expect, it} from 'vitest';
import {resolveHomeDirectory} from '../../src/effect/system.js';

describe('SystemInfo home directory resolution', () => {
  it('ignores empty Windows home variables', () => {
    expect(
      resolveHomeDirectory(
        {
          HOME: '',
          HOMEDRIVE: 'C:',
          HOMEPATH: '\\Users\\threadnote',
          USERPROFILE: '   ',
        },
        'win32',
      ),
    ).toBe('C:\\Users\\threadnote');
  });

  it('uses a non-empty POSIX HOME before compatibility variables', () => {
    expect(resolveHomeDirectory({HOME: '/home/threadnote', USERPROFILE: '/fallback'}, 'linux')).toBe(
      '/home/threadnote',
    );
  });

  it('fails explicitly when no home directory is available', () => {
    expect(() => resolveHomeDirectory({HOME: '', USERPROFILE: ''}, 'linux')).toThrow(
      'Could not determine the current user home directory',
    );
  });
});
