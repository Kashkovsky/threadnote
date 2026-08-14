import {describe, expect, it} from 'vitest';

describe('remote memory PostgreSQL JSON boundary', () => {
  // These are direct checkout file boundaries, so a Promise test is appropriate.
  it('passes JSON values to the postgres.js serializer exactly once', async () => {
    const [controlPlane, operator] = await Promise.all([
      Bun.file('src/remote_memory/postgres_control_plane.ts').text(),
      Bun.file('src/remote_memory/operator_postgres.ts').text(),
    ]);

    expect(controlPlane).toContain('${transaction.json(desiredSharePolicy.document)}');
    expect(controlPlane).toContain('${transaction.json(desiredPolicy.document)}');
    expect(controlPlane).toContain('${transaction.json(retentionPolicy.document)}');
    expect(operator).toContain('${transaction.json(outcomes.map(outcome => ({...outcome})))}');
    expect(operator).toContain('${transaction.json(migrationPolicyDocument)}');
    expect(`${controlPlane}\n${operator}`).not.toMatch(/\$\{JSON\.stringify\([^}]+\)\}::jsonb/u);
    expect(operator).not.toContain('${migrationPolicyDocument}::jsonb');
  });
});
