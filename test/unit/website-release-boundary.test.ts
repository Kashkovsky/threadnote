import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {access, mkdir, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {assertPerformanceSourceClean} from '../../scripts/site-performance-evidence.js';

const root = process.cwd();

describe('website and standalone release boundary', () => {
  it('keeps documentation and website trees out of the standalone build', async () => {
    const buildSource = await readFile(join(root, 'scripts', 'build.ts'), 'utf8');

    expect(buildSource).toContain("const RELEASE_DIRECTORIES = ['assets', 'config', 'manager'] as const;");
    expect(buildSource).toContain(
      "const FORBIDDEN_RELEASE_DIRECTORIES = ['docs', 'training', 'website', 'site-dist'] as const;",
    );
  });

  it('uses one small-scale graph mark across README, website, and packaged Manager surfaces', async () => {
    const canonicalPath = join(root, 'assets', 'brand', 'threadnote-logo.svg');
    const websitePath = join(root, 'website', 'public', 'threadnote-logo.svg');
    const [canonical, website, readme, brand, managerSource, managerUi, selfContainedCheck] = await Promise.all([
      readFile(canonicalPath, 'utf8'),
      readFile(websitePath, 'utf8'),
      readFile(join(root, 'README.md'), 'utf8'),
      readFile(join(root, 'website', 'src', 'components', 'Brand.tsx'), 'utf8'),
      readFile(join(root, 'src', 'manager.ts'), 'utf8'),
      readFile(join(root, 'src', 'manager_ui.tsx'), 'utf8'),
      readFile(join(root, 'scripts', 'check-self-contained.ts'), 'utf8'),
    ]);

    expect(website).toBe(canonical);
    expect(readme).toContain('./assets/brand/threadnote-logo.svg');
    expect(brand).toContain("siteHref('threadnote-logo.svg')");
    expect(brand).not.toContain('<svg');
    expect(managerSource).toContain("directory: 'assets/brand'");
    expect(managerSource).not.toContain('threadnote-logo-inverted.svg');
    expect(managerUi).toContain('src="/threadnote-logo.svg"');
    expect(selfContainedCheck).toContain('standalone build output does not contain the canonical Threadnote logo');

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
      'performance/index.html',
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

  it('keeps retained evidence binding Bun-only and outside the standalone payload', async () => {
    const [evidenceBuild, viteConfig, standaloneBuild, manifest] = await Promise.all([
      readFile(join(root, 'scripts', 'site-performance-evidence.ts'), 'utf8'),
      readFile(join(root, 'website', 'vite.config.ts'), 'utf8'),
      readFile(join(root, 'scripts', 'build.ts'), 'utf8'),
      readFile(join(root, 'package.json'), 'utf8'),
    ]);

    expect(evidenceBuild).toContain("new Bun.CryptoHasher('sha256')");
    expect(evidenceBuild).toContain('performance-evidence.json');
    expect(evidenceBuild).toContain('evidence.binding.json');
    expect(evidenceBuild).not.toMatch(/from ['"]node:/);
    expect(viteConfig).not.toMatch(/from ['"]node:/);
    expect(viteConfig).toContain('virtual:threadnote-performance-evidence');
    expect(JSON.parse(manifest)).toMatchObject({
      scripts: {'site:bind-performance-evidence': 'bun scripts/site-performance-evidence.ts'},
    });
    expect(evidenceBuild).toContain('writePerformanceArtifactBinding');
    expect(evidenceBuild).toContain('assertPerformanceSourceClean');
    expect(standaloneBuild).toContain(
      "const FORBIDDEN_RELEASE_DIRECTORIES = ['docs', 'training', 'website', 'site-dist'] as const;",
    );
    expect(standaloneBuild).not.toContain('site-performance-evidence');
  });

  it('rejects tracked, staged, and untracked changes in performance-bound source paths', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'threadnote-performance-source-'));
    const git = (...arguments_: string[]) =>
      execFileSync('git', arguments_, {cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
    try {
      await mkdir(join(repository, 'src'));
      await writeFile(join(repository, 'src', 'tracked.ts'), 'export const value = 1;\n');
      await writeFile(join(repository, '.gitignore'), 'src/ignored.ts\n');
      git('init');
      git('add', '.');
      git('-c', 'user.name=Threadnote Test', '-c', 'user.email=threadnote@example.invalid', 'commit', '-m', 'fixture');
      expect(() => assertPerformanceSourceClean(repository)).not.toThrow();

      await writeFile(join(repository, 'src', 'tracked.ts'), 'export const value = 2;\n');
      expect(() => assertPerformanceSourceClean(repository)).toThrow('tracked working-tree modifications');
      git('restore', 'src/tracked.ts');

      await writeFile(join(repository, 'src', 'tracked.ts'), 'export const value = 3;\n');
      git('add', 'src/tracked.ts');
      expect(() => assertPerformanceSourceClean(repository)).toThrow('staged modifications');
      git('restore', '--staged', '--worktree', 'src/tracked.ts');

      await writeFile(join(repository, 'src', 'untracked.ts'), 'export const untracked = true;\n');
      expect(() => assertPerformanceSourceClean(repository)).toThrow('untracked files');
      await rm(join(repository, 'src', 'untracked.ts'));

      await writeFile(join(repository, 'src', 'ignored.ts'), 'export const ignored = true;\n');
      expect(() => assertPerformanceSourceClean(repository)).toThrow('untracked files');
    } finally {
      await rm(repository, {force: true, recursive: true});
    }
  });

  it('gates the Pages deployment on website contract checks', async () => {
    const workflow = await readFile(join(root, '.github', 'workflows', 'pages.yml'), 'utf8');

    await expect(access(join(root, 'docs', 'index.html'))).rejects.toThrow();
    await expect(access(join(root, 'website', 'public', 'CNAME'))).rejects.toThrow();
    expect(workflow).toContain('bun run site:check');
    expect(workflow).toContain('bun run site:build');
    expect(workflow).toContain('fetch-depth: 0');
    const pushTrigger = workflow.slice(workflow.indexOf('  push:'), workflow.indexOf('  workflow_dispatch:'));
    expect(pushTrigger).toContain('paths:');
    expect(pushTrigger).toContain("'website/**'");
    expect(pushTrigger).toContain("'scripts/site-performance-evidence.ts'");
    expect(pushTrigger).toContain("'src/evaluation/benchmark.ts'");
    expect(pushTrigger).not.toContain("'src/**'");
    expect(workflow).toContain('path: site-dist');
    expect(workflow).toContain('actions/deploy-pages@');
    expect(workflow).toMatch(/^ {2}THREADNOTE_SITE_BASE: \/$/m);
  });

  it('uses threadnote.io as the single public website origin', async () => {
    const origin = 'https://threadnote.io';
    const entries = [
      ['index.html', '/'],
      ['performance/index.html', '/performance/'],
      ['docs/index.html', '/docs/'],
      ['pro-tips/index.html', '/pro-tips/'],
      ['manager-demo/index.html', '/manager-demo/'],
      ['faq/index.html', '/faq/'],
    ] as const;
    const htmlDocuments = await Promise.all(
      entries.map(async ([entry, route]) => ({
        route,
        html: await readFile(join(root, 'website', entry), 'utf8'),
      })),
    );

    for (const {route, html} of htmlDocuments) {
      expect(html).toContain(`<link rel="canonical" href="${origin}${route}" />`);
      expect(html).toContain(`<meta property="og:url" content="${origin}${route}" />`);
      expect(html).toContain(`<meta property="og:image" content="${origin}/og.png" />`);
      expect(html).toContain(`<meta name="twitter:image" content="${origin}/og.png" />`);
      expect(html).not.toContain('kashkovsky.github.io/threadnote');
    }

    const structuredDataSource = htmlDocuments[0]?.html.match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    )?.[1];
    expect(structuredDataSource).toBeDefined();
    expect(JSON.parse(structuredDataSource ?? '{}')).toMatchObject({
      '@context': 'https://schema.org',
      '@graph': [
        {'@type': 'WebSite', url: `${origin}/`},
        {'@type': 'SoftwareApplication', url: `${origin}/`},
      ],
    });

    const [sitemap, robots, readme, manifest, pagesWorkflow, ciWorkflow] = await Promise.all([
      readFile(join(root, 'website', 'public', 'sitemap.xml'), 'utf8'),
      readFile(join(root, 'website', 'public', 'robots.txt'), 'utf8'),
      readFile(join(root, 'README.md'), 'utf8'),
      readFile(join(root, 'package.json'), 'utf8'),
      readFile(join(root, '.github', 'workflows', 'pages.yml'), 'utf8'),
      readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'),
    ]);
    const sitemapLocations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);

    expect(sitemapLocations).toEqual(entries.map(([, route]) => `${origin}${route}`));
    expect(robots).toContain(`Sitemap: ${origin}/sitemap.xml`);
    expect(readme).toContain(`**Website:** ${origin}/`);
    expect(readme).toContain(`**Documentation:** ${origin}/docs/`);
    expect(JSON.parse(manifest)).toMatchObject({homepage: `${origin}/`});
    expect(pagesWorkflow).toMatch(/^ {2}THREADNOTE_SITE_BASE: \/$/m);
    expect(ciWorkflow).toMatch(/^ {10}THREADNOTE_SITE_BASE: \/$/m);
    expect(ciWorkflow).toContain('fetch-depth: 0');

    for (const source of [sitemap, robots, readme, manifest, pagesWorkflow, ciWorkflow]) {
      expect(source).not.toContain('kashkovsky.github.io/threadnote');
    }
  });

  it('packages the agent instruction template outside the public docs tree', async () => {
    const lifecycle = await readFile(join(root, 'src', 'lifecycle.ts'), 'utf8');
    const template = await stat(join(root, 'config', 'agent-instructions.md'));

    expect(lifecycle).toContain("'config', 'agent-instructions.md'");
    expect(lifecycle).not.toContain("'docs', 'agent-instructions.md'");
    expect(template.isFile()).toBe(true);
  });
});
