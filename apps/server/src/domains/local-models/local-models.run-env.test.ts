import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AGENT_MIN_CONTEXT } from '@agentdeck/contracts/local-models';
import { createLocalModels, templateHashOf } from './service.ts';
import { localPaths } from './paths.ts';

/**
 * Окно, которое сервис моделей отдаёт прогонам и шлюзу: окно ЗАПУЩЕННОГО
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

describe('пометка отложенных инструментов', () => {
  const paths = (): ReturnType<typeof localPaths> =>
    localPaths(root, { AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm') });
  function withTemplate(hash: (file: string) => string | undefined): void {
    writeRecord(65_536);
    const file = join(root, 'tpl.jinja');
    writeFileSync(file, '{{ messages }}');
    const record = JSON.parse(readFileSync(paths().pidFile, 'utf8')) as Record<string, unknown>;
    writeFileSync(
      paths().pidFile,
      JSON.stringify({ ...record, templateFile: file, templateHash: hash(file) }),
    );
  }

  it('сервер поднят с нынешним шаблоном — шлюз ставит пометку', () => {
    withTemplate((file) => templateHashOf(file));
    expect(service().upstream('qwen3.6:27b-coding')?.deferredInline).toBe(true);
  });

  it('шаблон на диске сменился после подъёма — пометки нет: сервер показал бы её модели', () => {
    withTemplate(() => 'stale');
    expect(service().upstream('qwen3.6:27b-coding')?.deferredInline).toBe(false);
  });
});

describe('окно для шлюза', () => {
  it('есть запись — окно; замера скорости нет — поля скорости тоже', () => {
    writeRecord(65_536);
    expect(service().upstream('qwen3.6:27b-coding')).toEqual({
      context: 65_536,
      prepare: expect.any(Function),
      revive: expect.any(Function),
      notice: expect.any(Function),
      watch: expect.any(Function),
      layer: expect.any(Function),
      deferredInline: false,
    });
  });

  it('замер скорости обработки промпта этой модели едет шлюзу — по нему считается срок первого байта', () => {
    writeRecord(65_536);
    const paths = localPaths(root, { AGENTDECK_LOCAL_MODELS_DIR: join(root, 'lm') });
    writeFileSync(
      paths.state,
      JSON.stringify({
        bench: {
          'qwen3.6:27b-coding': {
            tokensPerSec: 103.2,
            promptTokensPerSec: 364,
            measuredAt: '2026-10-12',
            gpu: 'RTX 4090',
          },
        },
      }),
    );
    expect(service().upstream('qwen3.6:27b-coding')).toEqual({
      context: 65_536,
      promptTokensPerSecond: 364,
      prepare: expect.any(Function),
      revive: expect.any(Function),
      notice: expect.any(Function),
      watch: expect.any(Function),
      layer: expect.any(Function),
      deferredInline: false,
    });
    // Замер другой модели этой не принадлежит.
    expect(service().upstream('other:1b')).toEqual({
      context: 65_536,
      prepare: expect.any(Function),
      revive: expect.any(Function),
      notice: expect.any(Function),
      watch: expect.any(Function),
      layer: expect.any(Function),
      deferredInline: false,
    });
  });

  it('записи нет — шлюзу нечем отказывать: пусто', () => {
    expect(service().upstream('qwen3.6:27b-coding')).toBeUndefined();
  });
});
