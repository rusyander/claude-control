import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionSpec } from '../adapter.types.ts';
import { homeDir } from '../../platform/os-kind.ts';
import { trustedLayer } from '../sdk-stream/layer-run.ts';
import { qwenPathPattern } from './permission.ts';
import { planQwen } from './qwen.ts';

/**
 * Очередь машины (этап 11, P141: аренды мест всех ядер машины) — путь платформы наравне с домом
 * ядра: правила CLI Qwen запрещают каждый её предок как корень поиска (F-13), а не только предки
 * дома ядра. Настоящий план переходника; пути — строки, файлов нет.
 */

const HOME = homeDir();
const COPY = join(HOME, 'work', 'copy');
const CORE_HOME = join(HOME, '.agentdeck-core-qwen-mq');
// Очередь на своём корне рядом с домом человека: её предок не совпадает с предками дома ядра.
const QUEUE_PARENT = join(HOME, '..', 'qwen-mq-machine');
const QUEUE = join(QUEUE_PARENT, 'queue');

function spec(machineQueue: string | undefined): SessionSpec {
  return {
    sessionId: '33333333-3333-4333-8333-333333333333',
    dir: join(COPY, '..', 'session'),
    cwd: COPY,
    brief: 'BRIEF',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: CORE_HOME, tokenFiles: [], ...(machineQueue ? { machineQueue } : {}) },
    tools: 'all',
    mcpServers: {},
    layer: { hooks: 'on', skills: 'on' },
    env: { pin: {} },
    coreHook: 'node hook.mjs core',
    core: {
      taskId: 't',
      stepId: 's',
      stepKind: 'implement',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'tok',
    },
  };
}

function denyOf(machineQueue: string | undefined): string[] {
  const s = spec(machineQueue);
  const plan = planQwen(s, null, trustedLayer(s));
  return JSON.parse(plan.files['qwen/system-settings.json']!).permissions.deny as string[];
}

describe('qwen: the machine queue is a platform path for the search-root rules', () => {
  it('every ancestor of the machine queue is denied as a search root; without it — not', () => {
    const rule = `read_file(${qwenPathPattern(COPY, QUEUE_PARENT)})`;
    expect(denyOf(QUEUE)).toContain(rule);
    expect(denyOf(undefined)).not.toContain(rule);
  });
});
