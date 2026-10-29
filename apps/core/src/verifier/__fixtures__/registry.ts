import type { CheckEntry, CheckRegistry, TreeRow } from '@agentdeck/contracts/core/records';

/**
 * Реестр-образец зоны A, пока профиль (зона E) не строит настоящий: две единицы, общая
 * библиотека, обвязка. Только для тестов.
 */
export function fixtureEntry(over: Partial<CheckEntry> = {}): CheckEntry {
  return {
    id: 'tests',
    class: 'test-runner',
    argv: ['vitest', 'run', '{units}'],
    cwd: '',
    unit: 'package',
    requiredAt: ['publish'],
    baseDependent: false,
    filter: { kind: 'vitest', argv: ['vitest', 'run', '{files}', '-t', '{tests}'] },
    inputs: [],
    envAllow: ['NODE_ENV', 'APP_*'],
    tools: ['node'],
    artifacts: [],
    needs: [],
    source: 'detected',
    ...over,
  };
}

export function fixtureRegistry(over: Partial<CheckRegistry> = {}): CheckRegistry {
  return {
    units: {
      app: { paths: ['apps/app/'], consumes: ['shared'] },
      admin: { paths: ['apps/admin/'], consumes: [] },
      shared: { paths: ['packages/shared/'], consumes: [] },
    },
    machinery: ['vitest.config.ts', 'tools/gate.mjs'],
    checks: [fixtureEntry(), fixtureEntry({ id: 'lint', class: 'static', filter: undefined })],
    rejected: [],
    ...over,
  };
}

const blob = (n: number): string => n.toString(16).padStart(40, '0');

/** Строки дерева образца; `edit` — заменить blob или режим одного пути. */
export function fixtureRows(edit: Record<string, Partial<TreeRow>> = {}): TreeRow[] {
  const base: TreeRow[] = [
    { path: 'apps/app/main.ts', mode: '100644', blob: blob(1) },
    { path: 'apps/admin/main.ts', mode: '100644', blob: blob(2) },
    { path: 'packages/shared/index.ts', mode: '100644', blob: blob(3) },
    { path: 'vitest.config.ts', mode: '100644', blob: blob(4) },
    { path: 'tools/gate.mjs', mode: '100644', blob: blob(5) },
    { path: 'README.md', mode: '100644', blob: blob(6) },
  ];
  return base.map((row) => ({ ...row, ...edit[row.path] }));
}

export const otherBlob = blob(99);
