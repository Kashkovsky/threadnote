import {mkdtemp, mkdir, rm, symlink, writeFile} from '../helpers/node-fs-promises.js';
import {tmpdir} from '../helpers/node-os.js';
import {join} from '../helpers/node-path.js';
import {afterEach, describe, expect, it} from 'vitest';
import {
  CODE_MEMORY_LINK_SAFE_EXECUTABLE_NAMES,
  buildCodeMemoryLinkCodexConfig,
  copyFixtureTree,
  parseCodeMemoryLinkCodexClientConfigV1,
  sanitizeCodeMemoryLinkAppServerEnvironment,
  type CodeMemoryLinkCodexClientConfigV1,
} from '../../scripts/code-memory-link-codex-isolation.js';

describe('Code Memory Link Codex isolation', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map(root => rm(root, {force: true, recursive: true})));
  });

  it('constructs a fresh allowlisted environment without inherited Threadnote or host state', () => {
    const environment = sanitizeCodeMemoryLinkAppServerEnvironment({
      codexHome: '/private/codex',
      home: '/private/home',
      proxyPacketPath: '/private/packet.json',
      safeExecutablePath: '/usr/bin:/bin',
      temporaryDirectory: '/private/tmp',
    });

    expect(environment).toEqual({
      CODE_MEMORY_LINK_PROXY_PACKET: '/private/packet.json',
      CODEX_HOME: '/private/codex',
      HOME: '/private/home',
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      NO_COLOR: '1',
      PATH: '/usr/bin:/bin',
      TMPDIR: '/private/tmp',
    });
    expect(Object.keys(environment).some(key => key.startsWith('THREADNOTE_'))).toBe(false);
  });

  it('generates a strict config with exactly one proxy and no ambient agent surfaces', () => {
    const generated = buildCodeMemoryLinkCodexConfig({
      config: config(),
      instructionPath: '/private/codex/instructions.md',
      proxyPacketEnvironmentName: 'CODE_MEMORY_LINK_PROXY_PACKET',
      repositoryRoot: '/public/repository',
    });

    expect(generated.match(/^\[mcp_servers\./gmu)).toHaveLength(1);
    expect(generated).toContain('[mcp_servers.context_brief_gate]');
    expect(generated).toContain('enabled_tools = ["context_brief"]');
    expect(generated).toContain('args = ["/reviewed/proxy.bundle.js"]');
    expect(generated).toContain('inherit = "none"');
    expect(generated).toContain('sandbox_mode = "workspace-write"');
    expect(generated).toContain('web_search = false');
    expect(generated).toContain('persistence = "none"');
    expect(generated).toContain('apps = false');
    expect(generated).toContain('plugins = false');
    expect(generated).toContain('hooks = false');
    expect(generated).toContain('multi_agent = false');
    expect(generated).toContain('non_prefixed_mcp_tool_names = true');
    expect(generated).toContain('suppress_unstable_features_warning = true');
    expect(generated).not.toContain('[agents]');
    expect(generated).not.toContain('view_image');
    expect(generated).not.toContain('THREADNOTE_');
    expect(generated).not.toContain('/sealed/suite');
    expect(generated).not.toContain('auth.json');
    expect(generated).not.toContain('code-memory-link-context-proxy.ts');
  });

  it('rejects unsupported models and extra mutable configuration fields', () => {
    expect(() => parseCodeMemoryLinkCodexClientConfigV1({...config(), extra: true})).toThrow(
      'unsupported or missing fields',
    );
    expect(() =>
      parseCodeMemoryLinkCodexClientConfigV1({...config(), model: {...config().model, id: 'gpt-unreviewed'}}),
    ).toThrow('two reviewed gate clients');
    expect(() =>
      parseCodeMemoryLinkCodexClientConfigV1({...config(), safeBinaries: config().safeBinaries.slice(1)}),
    ).toThrow('complete reviewed command set');
  });

  it('rejects symlinks and agent-control files while copying a public fixture', async () => {
    const source = await temporaryRoot(temporaryRoots);
    const outside = await temporaryRoot(temporaryRoots);
    await writeFile(join(outside, 'private.txt'), 'private\n');
    await symlink(join(outside, 'private.txt'), join(source, 'escape'));
    await expect(copyFixtureTree(source, join(await temporaryRoot(temporaryRoots), 'copy'))).rejects.toThrow(
      'symlinks are forbidden',
    );

    const controlled = await temporaryRoot(temporaryRoots);
    await mkdir(join(controlled, '.codex'));
    await writeFile(join(controlled, '.codex/config.toml'), 'hooks = {}\n');
    await expect(copyFixtureTree(controlled, join(await temporaryRoot(temporaryRoots), 'copy'))).rejects.toThrow(
      'forbidden agent control file',
    );

    const instructions = await temporaryRoot(temporaryRoots);
    await writeFile(join(instructions, 'AGENTS.md'), 'read the rubric\n');
    await expect(copyFixtureTree(instructions, join(await temporaryRoot(temporaryRoots), 'copy'))).rejects.toThrow(
      'forbidden agent control file',
    );
  });
});

function config(): CodeMemoryLinkCodexClientConfigV1 {
  return {
    appServer: {
      executable: '/opt/codex/0.144.5/codex',
      executableSha256: 'a'.repeat(64),
      version: 'codex-cli 0.144.5',
    },
    authSourcePath: '/host/codex/auth.json',
    git: {executable: '/private/safe-bin/git', executableSha256: 'c'.repeat(64)},
    limits: {turnTimeoutMilliseconds: 900_000},
    model: {id: 'gpt-5.6-luna', provider: 'openai', reasoningEffort: 'medium'},
    proxy: {
      bunExecutable: '/opt/bun/bin/bun',
      bunExecutableSha256: 'd'.repeat(64),
      bundlePath: '/reviewed/proxy.bundle.js',
      bundleSha256: 'b'.repeat(64),
    },
    safeBinaries: CODE_MEMORY_LINK_SAFE_EXECUTABLE_NAMES.map((name, index) => ({
      name,
      path: `/private/safe-bin/${name}`,
      sha256: index.toString(16).repeat(64),
    })),
    safeExecutablePath: '/private/safe-bin',
    sealedSuite: {layoutArtifactId: `art_${'1'.repeat(16)}`, root: '/sealed/suite'},
    temporaryRoot: '/private/tmp',
    version: 1,
  };
}

async function temporaryRoot(roots: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'threadnote-codex-isolation-test-'));
  roots.push(root);
  return root;
}
