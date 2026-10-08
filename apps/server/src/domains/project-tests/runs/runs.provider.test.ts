import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatRun } from '../../chat/ChatRunner/ChatRunner.ts';
import { defaultCliCommand } from '../../../providers/cli/cli.ts';
import { CodexTestsRun } from '../agent/codex-run.ts';
import { QwenTestsRun } from '../agent/qwen-run.ts';
import type { TestsAgentStartOptions } from '../agent/agent-run.types.ts';
import * as permissions from '../run-permissions/run-permissions.ts';
import { ProjectTestRunRegistry } from './runs.ts';
import { createGroup, upsertCase } from '../store/store.ts';

/**
 * Агент тестов идёт CLI выбранного провайдера: Claude Code — прежним `ChatRun`
 * без своей команды (CLI по умолчанию), Qwen Code и Codex — своими запусками с
 * проверкой прав (`agent/`). Главное отличие чужого CLI: без приёмника прав
 * прогона НЕТ — запасного `bypassPermissions`, как у Claude, не бывает.
 */
describe('project-tests/runs: исполнитель прогона', () => {
  let root = '';
  let registry = new ProjectTestRunRegistry();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-tests-provider-'));
    registry = new ProjectTestRunRegistry();
    createGroup(root, 'gui');
    upsertCase(root, 'gui', { title: 'A', steps: ['x'] }, '2026-09-26T00:00:00.000Z');
  });

  afterEach(() => {
    registry.stop(root);
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it.each(['run', 'generate', 'automate'] as const)(
    '%s без провайдера — Claude Code CLI по умолчанию',
    async (mode) => {
      const start = vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async () => undefined);

      const view = registry.start(
        { projectPath: root, mode, groupId: 'gui' },
        '2026-09-26T00:00:00.000Z',
      );
      await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));

      const options = start.mock.calls[0]![0] as { command?: string; permissionMode?: string };
      expect(options.command).toBeUndefined();
      expect(options.permissionMode).toBe('default');
      expect(defaultCliCommand()).toMatch(/claude/i);
      expect(view.provider).toBe('claude');
    },
  );

  it.each([
    ['qwen', 'Qwen Code', QwenTestsRun],
    ['codex', 'Codex', CodexTestsRun],
  ] as const)('%s — свой запуск с приёмником прав и границами прогона', async (id, name, Run) => {
    const claude = vi.spyOn(ChatRun.prototype, 'start');
    const start = vi.spyOn(Run.prototype, 'start').mockImplementation(async () => undefined);

    const view = registry.start(
      { projectPath: root, mode: 'run', groupId: 'gui' },
      '2026-09-26T00:00:00.000Z',
      undefined,
      () => ({ values: { STAND_TOKEN: 's3cret' }, missing: [] }),
      { provider: { id, name, command: `C:/bin/${id}.cmd` } },
    );
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    expect(claude).not.toHaveBeenCalled();
    const options = start.mock.calls[0]![0] as TestsAgentStartOptions;
    expect(options.command).toBe(`C:/bin/${id}.cmd`);
    expect(options.providerName).toBe(name);
    expect(options.cwd).toBe(root);
    expect(options.env).toEqual({ STAND_TOKEN: 's3cret' });
    expect(options.gate.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(options.scope).toMatchObject({ root, mode: 'run' });
    // Секрет — только переменной процесса, в задании его нет.
    expect(options.prompt).not.toContain('s3cret');
    expect(view.provider).toBe(id);
  });

  it('чужой CLI и приёмник не поднялся — прогон не идёт, ошибка с кодом; полного доступа нет', async () => {
    vi.spyOn(permissions, 'startPermissionGate').mockRejectedValue(new Error('EADDRINUSE'));
    const start = vi.spyOn(QwenTestsRun.prototype, 'start');

    registry.start(
      { projectPath: root, mode: 'run', groupId: 'gui' },
      '2026-09-26T00:00:00.000Z',
      undefined,
      undefined,
      { provider: { id: 'qwen', name: 'Qwen Code', command: 'qwen' } },
    );
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('error'));

    expect(start).not.toHaveBeenCalled();
    expect(registry.get(root)).toMatchObject({
      messageCode: 'tests-agent-gate-unavailable',
      params: { provider: 'Qwen Code' },
    });
  });

  it('Claude и приёмник не поднялся — прежний запасной путь остаётся только у Claude', async () => {
    vi.spyOn(permissions, 'startPermissionGate').mockRejectedValue(new Error('EADDRINUSE'));
    const start = vi.spyOn(ChatRun.prototype, 'start').mockImplementation(async () => undefined);

    registry.start({ projectPath: root, mode: 'run', groupId: 'gui' }, '2026-09-26T00:00:00.000Z');
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    expect((start.mock.calls[0]![0] as { permissionMode?: string }).permissionMode).toBe(
      'bypassPermissions',
    );
  });

  it('чужой CLI: «Стоп», пока поднимался приёмник прав, — CLI не запущен, приёмник закрыт', async () => {
    const original = permissions.startPermissionGate;
    const closed: string[] = [];
    vi.spyOn(permissions, 'startPermissionGate').mockImplementation(async (...args) => {
      const gate = await original(...args);
      const close = gate.close.bind(gate);
      gate.close = () => {
        closed.push(gate.runId);
        close();
      };
      return gate;
    });
    const start = vi
      .spyOn(QwenTestsRun.prototype, 'start')
      .mockImplementation(async () => undefined);

    registry.start(
      { projectPath: root, mode: 'run', groupId: 'gui' },
      '2026-09-26T00:00:00.000Z',
      undefined,
      undefined,
      { provider: { id: 'qwen', name: 'Qwen Code', command: 'qwen' } },
    );
    expect(registry.stop(root)).toBe(true);
    await vi.waitFor(() => expect(closed).toHaveLength(1));

    expect(start).not.toHaveBeenCalled();
    expect(registry.get(root)?.status).toBe('stopped');
  });

  it('чужой CLI и контур включён между стартом и запуском — отказ с кодом, CLI не запущен', async () => {
    registry.setPlatformRouting(() => ({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' } }));
    const start = vi.spyOn(CodexTestsRun.prototype, 'start');

    registry.start(
      { projectPath: root, mode: 'run', groupId: 'gui' },
      '2026-09-26T00:00:00.000Z',
      undefined,
      undefined,
      { provider: { id: 'codex', name: 'Codex', command: 'codex' } },
    );
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('error'));

    expect(start).not.toHaveBeenCalled();
    expect(registry.get(root)?.messageCode).toBe('tests-agent-contour-foreign');
    expect(registry.routesThroughContour()).toBe(true);
  });

  it('ошибка чужого прогона с кодом доезжает до вида и записи; сессии нет', async () => {
    vi.spyOn(QwenTestsRun.prototype, 'start').mockImplementation(async (_options, onEvent) => {
      onEvent({
        kind: 'error',
        message: 'Прогон остановлен: Qwen Code выполнил «write_file» мимо проверки прав панели.',
        messageCode: 'tests-agent-gate-bypassed',
        params: { provider: 'Qwen Code', tool: 'write_file' },
      });
    });

    registry.start(
      { projectPath: root, mode: 'run', groupId: 'gui' },
      '2026-09-26T00:00:00.000Z',
      undefined,
      undefined,
      { provider: { id: 'qwen', name: 'Qwen Code', command: 'qwen' } },
    );
    await vi.waitFor(() => expect(registry.get(root)?.status).toBe('error'));

    const view = registry.get(root);
    expect(view).toMatchObject({
      messageCode: 'tests-agent-gate-bypassed',
      params: { provider: 'Qwen Code', tool: 'write_file' },
      provider: 'qwen',
    });
    expect(view?.sessionId).toBeUndefined();
  });
});
