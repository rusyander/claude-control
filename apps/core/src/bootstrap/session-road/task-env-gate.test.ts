import { describe, expect, it } from 'vitest';
import { createAdapterRegistry } from '../../adapters/index.ts';
import { taskEnvRefusal, taskEnvSecrets } from './task-env-gate.ts';
import type { RoadStart } from './road.types.ts';

/**
 * Окружение задачи на дороге сеанса (этап 10, F6) против НАСТОЯЩИХ переходников реестра: кто чей
 * дом конфигурации читает — факт `readLayer` переходника, а не список имён в проверке.
 */

const registry = createAdapterRegistry();
const claude = registry.get('claude')!;
const qwen = registry.get('qwen')!;

const start = (
  env: string[] | undefined,
  pin: Record<string, string>,
  adapterId = 'claude',
): Pick<RoadStart, 'task' | 'pin' | 'adapterId'> =>
  ({
    task: { state: { created: env ? { session: { env } } : {} } },
    pin,
    adapterId,
  }) as unknown as Pick<RoadStart, 'task' | 'pin' | 'adapterId'>;

describe('taskEnvRefusal', () => {
  it('no task env — nothing to judge', () => {
    expect(taskEnvRefusal(start(undefined, {}), claude, registry)).toBeNull();
  });

  it('a named variable without a value (core restarted) — task-env-missing, not a run on the core env', () => {
    const reason = taskEnvRefusal(start(['CLAUDE_CONFIG_DIR'], {}), claude, registry);
    expect(reason).toMatch(/^task-env-missing: no value for CLAUDE_CONFIG_DIR/);
  });

  it('the session CLI honours its own config home — passes', () => {
    expect(
      taskEnvRefusal(
        start(['CLAUDE_CONFIG_DIR'], { CLAUDE_CONFIG_DIR: 'C:/sb/config' }),
        claude,
        registry,
      ),
    ).toBeNull();
  });

  it('another CLI config home on this adapter — task-env-unhonoured naming the owner', () => {
    const reason = taskEnvRefusal(
      start(['CLAUDE_CONFIG_DIR'], { CLAUDE_CONFIG_DIR: 'C:/sb/config' }, 'qwen'),
      qwen,
      registry,
    );
    expect(reason).toBe(
      'task-env-unhonoured: the task pins CLAUDE_CONFIG_DIR (the config home of claude); ' +
        'adapter qwen does not read it and would run on its own config',
    );
  });

  it('a plain secret nobody reads as a config home — passes on any adapter', () => {
    expect(
      taskEnvRefusal(start(['STAND_PASSWORD'], { STAND_PASSWORD: 's' }, 'qwen'), qwen, registry),
    ).toBeNull();
  });
});

describe('taskEnvSecrets', () => {
  it('masks every value except the session CLI config home', () => {
    const pin = { CLAUDE_CONFIG_DIR: 'C:/sb/config', STAND_PASSWORD: 's3cret', OTHER: 'x' };
    expect(taskEnvSecrets(start(['CLAUDE_CONFIG_DIR', 'STAND_PASSWORD'], pin), claude)).toEqual([
      ['STAND_PASSWORD', 's3cret'],
    ]);
  });
});
