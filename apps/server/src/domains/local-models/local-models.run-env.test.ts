import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AGENT_MIN_CONTEXT } from '@agentdeck/contracts/local-models';
import { createLocalModels } from './service.ts';
import { localPaths } from './paths.ts';

/**
 * Окно, которое сервис моделей отдаёт прогонам: окно ЗАПУЩЕННОГО
 * сервера из его записи, а не константа. Настоящие сервис и запись на диске в
 * временной папке; сети и процессов здесь нет.
 */

let root: string;

function service(): ReturnType<typeof createLocalModels> {
  return createLocalModels({
    appRoot: root,
    env: { AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm'), PATH: '', HOME: root, USERPROFILE: root },
  });
}

function writeRecord(context: number | undefined): void {
  const paths = localPaths(root, { AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm') });
  mkdirSync(paths.run, { recursive: true });
  writeFileSync(
    paths.pidFile,
    JSON.stringify({
      pid: 999_999_999,
      port: 11_499,
      binary: '',
      tag: 'qwen3.6:27b-coding',
      file: '/m/x.gguf',
      quant: 'Q4_K_M',
      kvCache: 'q8_0',
      mtp: true,
      offload: 'all',
      ...(context ? { context } : {}),
      device: 'gpu',
      startedAt: Date.now(),
    }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-local-runenv-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('окружение прогона из записи о сервере', () => {
  it('окно — окно запущенного сервера: и модели, и сжатия', () => {
    writeRecord(65_536);
    const env = service().runEnv();
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('65536');
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('65536');
    // Другое окно сервера — другое значение: константы в коде нет.
    writeRecord(131_072);
    expect(service().runEnv().CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('131072');
  });

  it('сервера нет — наименьшее окно агента: сжатие раньше, а не позже переполнения', () => {
    expect(service().runEnv().CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe(String(AGENT_MIN_CONTEXT));
  });

  it('поиск инструментов — только прогону через шлюз: мимо шлюза tool_reference некому развернуть', () => {
    writeRecord(65_536);
    expect(service().runEnv('gateway').ENABLE_TOOL_SEARCH).toBe('true');
    expect(service().runEnv('direct')).not.toHaveProperty('ENABLE_TOOL_SEARCH');
    expect(service().runEnv()).not.toHaveProperty('ENABLE_TOOL_SEARCH');
  });
});
