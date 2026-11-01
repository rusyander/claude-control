import { describe, expect, it } from 'vitest';
import type { PreflightInput } from '../preflight/preflight.types.ts';
import type { SplitEnv } from './estimate.types.ts';
import { publishesOf, runTaskPreflight } from './preflight-run.ts';

/**
 * Дорога `git-version` нужна только публикующей задаче: вход предпроверки несёт `publishes` из
 * сценария (шаг `publish` есть или нет); сценарий не разрешился — поля нет, дорога проверяется.
 */

function envSeeing(seen: PreflightInput[]): SplitEnv {
  return {
    remotesOf: async () => ({ value: [] }),
    needsServices: async () => false,
    preflight: async (input: PreflightInput) => {
      seen.push(input);
      return { start: true, roads: [], blocking: [] };
    },
  } as unknown as SplitEnv;
}

describe('task preflight: publishes comes from the scenario', () => {
  it('a publish step marks the task publishing; none — not publishing; unresolved — unset', () => {
    expect(publishesOf([{ kind: 'work' }, { kind: 'publish' }])).toBe(true);
    expect(publishesOf([{ kind: 'work' }, { kind: 'final-gate' }])).toBe(false);
    expect(publishesOf(undefined)).toBeUndefined();
  });

  it('the preflight input carries publishes only when the scenario said it', async () => {
    const seen: PreflightInput[] = [];
    const repos = [{ repoKey: 'r1', path: '/nowhere' }];
    await runTaskPreflight(repos, [], envSeeing(seen), false);
    await runTaskPreflight(repos, [], envSeeing(seen));
    expect(seen[0]?.publishes).toBe(false);
    expect(seen[1]).not.toHaveProperty('publishes');
  });
});
