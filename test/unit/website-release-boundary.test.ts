import {createHash} from 'node:crypto';
import {access, readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

const root = process.cwd();

describe('website and standalone release boundary', () => {
  it('keeps documentation and website trees out of the standalone build', async () => {
    const buildSource = await readFile(join(root, 'scripts', 'build.ts'), 'utf8');

    expect(buildSource).toContain("const RELEASE_DIRECTORIES = ['assets', 'config', 'manager'] as const;");
    expect(buildSource).toContain("const FORBIDDEN_RELEASE_DIRECTORIES = ['docs', 'website', 'site-dist'] as const;");
  });

  it('uses one small-scale graph mark across README, website, and packaged Manager surfaces', async () => {
    const canonicalPath = join(root, 'assets', 'brand', 'threadnote-logo.svg');
    const websitePath = join(root, 'website', 'public', 'threadnote-logo.svg');
    const [canonical, website, readme, brand, managerSource, managerUi] = await Promise.all([
      readFile(canonicalPath, 'utf8'),
      readFile(websitePath, 'utf8'),
      readFile(join(root, 'README.md'), 'utf8'),
      readFile(join(root, 'website', 'src', 'components', 'Brand.tsx'), 'utf8'),
      readFile(join(root, 'src', 'manager.ts'), 'utf8'),
      readFile(join(root, 'src', 'manager_ui.tsx'), 'utf8'),
    ]);

    expect(website).toBe(canonical);
    expect(readme).toContain('./assets/brand/threadnote-logo.svg');
    expect(brand).toContain("siteHref('threadnote-logo.svg')");
    expect(brand).not.toContain('<svg');
    expect(managerSource).toContain("directory: 'assets/brand'");
    expect(managerSource).not.toContain('threadnote-logo-inverted.svg');
    expect(managerUi).toContain('src="/threadnote-logo.svg"');

    expect(canonical).toContain('viewBox="0 0 4267 4267"');
    expect(canonical).toContain('fill="#67e8c7"');
    expect(canonical).not.toContain('linearGradient');
    expect(canonical).not.toContain('stop-color=');
    expect(canonical).not.toContain('stroke=');
    expect(canonical).not.toMatch(
      /<\?(?:xml)|<!DOCTYPE|<(?:circle|filter|foreignObject|image|rect|script|text)\b|(?:href|xlink:href)=/,
    );
    const markPaths = [...canonical.matchAll(/<path\b[^>]*\bd="([^"]+)"[^>]*\/>/g)].map(match => match[1]);
    expect(markPaths).toHaveLength(1);
    expect(markPaths[0]).toMatch(/Z$/);
    expect(
      createHash('sha256')
        .update(markPaths[0] ?? '')
        .digest('hex'),
    ).toBe('51b0989e27705e2338a58272feb519ac2ce37a49dfe536932c1ab2ad882f7427');

    for (const legacyPath of [
      join(root, 'docs', 'threadnote-logo.svg'),
      join(root, 'docs', 'threadnote-logo-inverted.svg'),
      join(root, 'manager', 'threadnote-logo.svg'),
      join(root, 'manager', 'threadnote-logo-inverted.svg'),
      join(root, 'website', 'public', 'favicon.svg'),
    ]) {
      await expect(access(legacyPath)).rejects.toThrow();
    }

    for (const entry of [
      'index.html',
      'docs/index.html',
      'pro-tips/index.html',
      'manager-demo/index.html',
      'faq/index.html',
    ]) {
      const html = await readFile(join(root, 'website', entry), 'utf8');
      expect(html).toContain('threadnote-logo.svg');
      expect(html).not.toContain('favicon.svg');
    }
  });

  it('does not invoke the public website from the CLI build', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts.build).not.toContain('site:');
    expect(manifest.scripts['site:build']).toBeDefined();
    expect(manifest.scripts['site:check']).toContain('site:test');
  });

  it('gates the Pages deployment on website contract checks', async () => {
    const workflow = await readFile(join(root, '.github', 'workflows', 'pages.yml'), 'utf8');

    expect(workflow).toContain("'assets/brand/**'");
    expect(workflow).toContain('bun run site:check');
    expect(workflow).toContain('bun run site:build');
    expect(workflow).toContain('actions/deploy-pages@');
  });

  it('packages the agent instruction template outside the public docs tree', async () => {
    const lifecycle = await readFile(join(root, 'src', 'lifecycle.ts'), 'utf8');
    const template = await stat(join(root, 'config', 'agent-instructions.md'));

    expect(lifecycle).toContain("'config', 'agent-instructions.md'");
    expect(lifecycle).not.toContain("'docs', 'agent-instructions.md'");
    expect(template.isFile()).toBe(true);
  });
});
