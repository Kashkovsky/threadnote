import {Schema} from 'effect';
import {
  declaredVirtualModules,
  moduleSpecifiers,
  validateWorkspaceBoundaries,
  type SourceModule,
  type WorkspacePackage,
} from './boundaries.js';

const Manifest = Schema.Struct({
  name: Schema.String,
  private: Schema.Boolean,
  exports: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  devDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const packages: WorkspacePackage[] = [];
for (const path of new Bun.Glob('{apps,packages}/*/package.json').scanSync('.')) {
  const manifest = Schema.decodeSync(Manifest)(await Bun.file(path).json());
  packages.push({
    ...manifest,
    directory: path.slice(0, -'/package.json'.length),
    exports: manifest.exports ?? {},
    dependencies: manifest.dependencies ?? {},
  });
}
const sources: SourceModule[] = [];
for (const path of new Bun.Glob('{scripts,tools,infra,apps,packages}/**/*.{ts,tsx,mts}').scanSync('.')) {
  if (
    path.includes('/node_modules/') ||
    path.includes('/fixtures/') ||
    path.includes('/dist/') ||
    path.startsWith('tools/bazel/spike/')
  )
    continue;
  const content = await Bun.file(path).text();
  sources.push({path, imports: moduleSpecifiers(path, content), virtualModules: declaredVirtualModules(path, content)});
}
const errors = [...validateWorkspaceBoundaries(packages, sources)];
for (const legacyRoot of ['src', 'test']) {
  const migratedFiles = [...new Bun.Glob(`${legacyRoot}/**/*`).scanSync('.')];
  if (migratedFiles.length > 0) errors.push(`${legacyRoot}/: root source trees must be owned by an app or package`);
}
for (const pkg of packages) {
  for (const entry of Object.values(pkg.exports)) {
    if (!(await Bun.file(`${pkg.directory}/${entry}`).exists()))
      errors.push(`${pkg.name}: missing exported file ${entry}`);
  }
}
if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Checked ${packages.length} private workspaces and ${sources.length} source modules.\n`);
}
