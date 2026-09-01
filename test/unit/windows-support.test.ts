import {describe, expect, it} from 'vitest';
import {isGitExecutable, resolveCommandInvocation} from '../../src/effect/command.js';
import {resolveHomeDirectory} from '../../src/effect/system.js';
import {validatePortableSegment} from '../../src/storage/resource-id.js';
import {executableNames} from '../../src/utils.js';

describe('Windows platform contracts', () => {
  it('expands PATHEXT for extensionless commands and preserves explicit launchers', () => {
    expect(executableNames('node', 'win32', '.COM;.EXE;.CMD')).toEqual(['node.COM', 'node.EXE', 'node.CMD', 'node']);
    expect(executableNames('threadnote.cmd', 'win32', '.COM;.EXE;.CMD')).toEqual(['threadnote.cmd']);
  });

  it('routes cmd launchers through ComSpec without changing native executable arguments', () => {
    expect(
      resolveCommandInvocation(
        'C:\\Program Files\\nodejs\\npm.cmd',
        ['install', 'package with spaces'],
        'win32',
        'C:\\Windows\\System32\\cmd.exe',
      ),
    ).toEqual({
      args: [],
      executable: 'C:\\Program^ Files\\nodejs\\npm.cmd ^"install^" ^"package^ with^ spaces^"',
      shell: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(resolveCommandInvocation('C:\\Program Files\\nodejs\\node.exe', ['--version'], 'win32')).toEqual({
      args: ['--version'],
      executable: 'C:\\Program Files\\nodejs\\node.exe',
    });
  });

  it('recognizes resolved Git launchers for environment sanitization', () => {
    expect(isGitExecutable('C:\\Program Files\\Git\\cmd\\git.EXE')).toBe(true);
    expect(isGitExecutable('C:\\tools\\git.cmd')).toBe(true);
    expect(isGitExecutable('C:\\tools\\not-git.exe')).toBe(false);
  });

  it('uses Windows home variables without requiring HOME', () => {
    expect(resolveHomeDirectory({USERPROFILE: 'C:\\Users\\dev'}, 'win32')).toBe('C:\\Users\\dev');
    expect(resolveHomeDirectory({HOMEDRIVE: 'D:', HOMEPATH: '\\Profiles\\dev'}, 'win32')).toBe('D:\\Profiles\\dev');
  });

  it('rejects Windows reserved names in portable resource identifiers', () => {
    expect(() => validatePortableSegment('CON', 'CON')).toThrow(/reserved/i);
    expect(() => validatePortableSegment('notes.', 'notes.')).toThrow();
    expect(() => validatePortableSegment('release-notes', 'release-notes')).not.toThrow();
  });

  it('verifies installer checksums without PowerShell module discovery', async () => {
    const installer = await Bun.file(new URL('../../scripts/install.ps1', import.meta.url)).text();

    expect(installer).toContain("Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Utility");
    expect(installer).toContain('Microsoft.PowerShell.Utility\\Get-FileHash');
    expect(installer).toContain('[Security.Cryptography.SHA256]::Create()');
  });

  it('accepts only an explicitly declared unsigned Windows payload and warns the user', async () => {
    const installer = await Bun.file(new URL('../../scripts/install.ps1', import.meta.url)).text();

    expect(installer).toContain('$metadataVersion = $metadata.version');
    expect(installer).toContain('$metadataVersion -isnot [string]');
    expect(installer).toContain('$metadataVersion -cne $version');
    expect(installer).toContain('$metadataExecutable = $metadata.executable');
    expect(installer).toContain('$metadataExecutable -isnot [string]');
    expect(installer).toContain("$metadataExecutable -cne 'threadnote.exe'");
    expect(installer).toContain('$codeSignature = $metadata.codeSignature');
    expect(installer).toContain('$codeSignature -isnot [string]');
    expect(installer).toContain("$codeSignature -cne 'unsigned'");
    expect(installer).toContain('This Windows release is unsigned');
    expect(installer).not.toContain('Get-AuthenticodeSignature');
  });

  it('downloads release archives as binary data on Windows PowerShell', async () => {
    const installer = await Bun.file(new URL('../../scripts/install.ps1', import.meta.url)).text();

    expect(installer).toContain('[System.Net.Http.HttpClient]::new()');
    expect(installer).toContain('[System.Net.Http.HttpCompletionOption]::ResponseHeadersRead');
    expect(installer).toContain('$cancellation.CancelAfter($downloadTimeout)');
    expect(installer).toContain('$sourceStream.CopyToAsync($destinationStream, 81920, $cancellation.Token)');
    expect(installer).not.toContain('[System.Net.WebClient]::new()');
    expect(installer).not.toContain('Invoke-WebRequest');
  });

  it('recovers cross-runtime locks and interrupted release promotion safely', async () => {
    const installer = await Bun.file(new URL('../../scripts/install.ps1', import.meta.url)).text();

    expect(installer).toContain('Get-ThreadnoteLockOwner');
    expect(installer).toContain('Read-ThreadnoteInstallationLock');
    expect(installer).toContain('[AllowEmptyString()][string]$Token');
    expect(installer).toContain('$script:installationLockAcquired = $true');
    expect(installer).toContain('-not $script:installationLockAcquired');
    expect(installer).toContain('processStartIdentity');
    expect(installer).toContain('$installationLockStaleAge');
    expect(installer).toContain('$lockInfo.LastWriteTimeUtc');
    expect(installer).toContain('Recover-ThreadnoteReleasePromotion');
    expect(installer).toContain('.promotion-backup');
    expect(installer).toContain('.promotion.json');
    expect(installer).toContain('Invoke-ThreadnoteWithRetry');
    expect(installer).toContain('Assert-ThreadnoteReleaseArchive');
    expect(installer).toContain("$type -notin @('-', 'd')");
  });

  it('selects the inclusive beta release channel from an explicit bootstrap flag', async () => {
    const installer = await Bun.file(new URL('../../scripts/install.ps1', import.meta.url)).text();

    expect(installer).toContain('[switch]$Beta');
    expect(installer).toContain("$channel = if ($Beta) { 'beta' }");
    expect(installer).toContain("'beta' { $null }");
    expect(installer).toContain('$null -ne $prerelease');
  });
});
