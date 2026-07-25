import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeEntry } from '../lib/safe-io.ts';
import { checkProvider, levelOf } from './provider-check.ts';
import type { AssistantRunResult } from './assistant-runner.ts';

/**
 * Проверка провайдера. Главное, что здесь доказывается: круг записи идёт на
 * КОПИИ, а настоящий файл пользователя остаётся байт в байт прежним — иначе
 * проверка портила бы то, что проверяет.
 *
 * Работаем на Codex: его каталог переносится документированной переменной
 * `CODEX_HOME`, значит один temp-каталог накрывает сразу четыре шага (mcp,
 * права, переменные окружения, инструкции) и тест не зависит от того, что
 * реально стоит на машине.
 */
const CONFIG = `approval_policy = "on-request"
sandbox_mode = "workspace-write"

[shell_environment_policy.set]
FOO = "bar"

[mcp_servers.demo]
command = "node"
args = ["server.js"]
`;

function okAssistant(): Promise<AssistantRunResult> {
  return Promise.resolve({
    ok: true,
    providerId: 'codex',
    mode: 'cli',
    reply: 'готов',
    experimental: true,
    reason: 'ok',
  });
}

describe('checkProvider', () => {
  let home: string;
  let appData: string;
  let previous: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-check-test-'));
    appData = join(home, 'app-data');
    mkdirSync(appData, { recursive: true });
    previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    writeFileSync(join(home, 'config.toml'), CONFIG);
    writeFileSync(join(home, 'AGENTS.md'), '# Правила\n');
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    removeEntry(home);
  });

  it('проходит все шаги и не трогает настоящие файлы', async () => {
    const before = readFileSync(join(home, 'config.toml'), 'utf8');

    const result = await checkProvider('codex', {
      appDataDir: appData,
      withAssistant: true,
      detectCli: () => true,
      runAssistantImpl: okAssistant,
    });

    const byId = Object.fromEntries(result.steps.map((step) => [step.id, step]));
    expect(byId.cli?.status).toBe('pass');
    expect(byId.config?.status).toBe('pass');
    expect(byId.mcp?.status).toBe('pass');
    expect(byId.permissions?.status).toBe('pass');
    expect(byId.env?.status).toBe('pass');
    expect(byId.instructions?.status).toBe('pass');
    expect(byId.assistant?.status).toBe('pass');
    expect(result.level).toBe('verified');

    // Файл пользователя не изменился, и пробный сервер в нём не появился.
    expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(before);
    expect(before).not.toContain('claude-control-check-probe');
    // Временные копии за собой убраны: в каталоге ровно то, что было.
    expect(readdirSync(home).sort()).toEqual(['AGENTS.md', 'app-data', 'config.toml']);
  });

  it('битый формат — отказ, а не молчаливый успех', async () => {
    writeFileSync(join(home, 'config.toml'), '[mcp_servers.demo\nэто не TOML');

    const result = await checkProvider('codex', {
      appDataDir: appData,
      withAssistant: false,
      detectCli: () => true,
    });

    const mcp = result.steps.find((step) => step.id === 'mcp');
    expect(mcp?.status).toBe('fail');
    expect(result.level).toBe('failed');
  });

  it('без CLI и без запуска ассистента уровень честно частичный', async () => {
    const result = await checkProvider('codex', {
      appDataDir: appData,
      withAssistant: false,
      detectCli: () => false,
    });

    expect(result.steps.find((step) => step.id === 'cli')?.status).toBe('warn');
    expect(result.steps.find((step) => step.id === 'assistant')?.status).toBe('skipped');
    expect(result.level).toBe('partial');
  });

  it('ассистент ответил ошибкой — проверка провалена', async () => {
    const result = await checkProvider('codex', {
      appDataDir: appData,
      withAssistant: true,
      detectCli: () => true,
      runAssistantImpl: () =>
        Promise.resolve({
          ok: false,
          providerId: 'codex',
          mode: 'cli',
          reply: '',
          experimental: true,
          reason: 'cli_error',
          error: 'exit code 1',
        }),
    });

    expect(result.steps.find((step) => step.id === 'assistant')?.status).toBe('fail');
    expect(result.level).toBe('failed');
  });

  it('claude: разделы на своих маршрутах пропускаются, а не проваливаются', async () => {
    const result = await checkProvider('claude', {
      appDataDir: appData,
      withAssistant: true,
      detectCli: () => true,
      runAssistantImpl: okAssistant,
    });

    for (const id of ['mcp', 'permissions', 'env']) {
      expect(result.steps.find((step) => step.id === id)?.status).toBe('skipped');
    }
    expect(result.level).not.toBe('failed');
  });
});

describe('levelOf', () => {
  it('пропуск ассистента не даёт «проверено»', () => {
    expect(
      levelOf([
        { id: 'cli', status: 'pass', detail: '' },
        { id: 'assistant', status: 'skipped', detail: '' },
      ]),
    ).toBe('partial');
  });

  it('один отказ перевешивает любые успехи', () => {
    expect(
      levelOf([
        { id: 'cli', status: 'pass', detail: '' },
        { id: 'mcp', status: 'fail', detail: '' },
        { id: 'assistant', status: 'pass', detail: '' },
      ]),
    ).toBe('failed');
  });
});
