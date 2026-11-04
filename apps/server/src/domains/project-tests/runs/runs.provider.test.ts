import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandOutcome } from '@agentdeck/contracts/core/commands';
import {
  FAKE_TURN,
  fakeCorePort,
  permitAsked,
  waitFor,
  type FakeCoreOptions,
} from '../agent/__fixtures__/fake-core-port.ts';
import { TESTS_CORE_STOP_REASON } from '../agent/core-run.ts';
import { ProjectTestRunRegistry } from './runs.ts';
import { createGroup, upsertCase } from '../store/store.ts';

/**
 * Агент тестов идёт задачей ядра (этап 10, F6): реестр прогонов ставит задачу `chat@1` на месте
 * в корне проекта, переходник — выбранный CLI (`set-cli`). Подменена только граница процесса
 * ядра (`setCorePort`): реестр, `TestsCoreRun`, сверка границ по настоящему git — свои.
 */
describe('project-tests/runs: прогон через ядро', () => {
  let root = '';
  let registry = new ProjectTestRunRegistry();
  const now = '2026-09-26T00:00:00.000Z';

  const git = (...args: string[]): void => {
    const out = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (out.status !== 0) throw new Error(`git ${args.join(' ')}: ${out.stderr}`);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-tests-provider-'));
    registry = new ProjectTestRunRegistry();
    createGroup(root, 'gui');
    upsertCase(root, 'gui', { title: 'A', steps: ['x'] }, now);
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'app.ts'), 'export {};\n');
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'a@b.c');
    git('config', 'user.name', 'a');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    registry.stop(root);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const launch = (
    opts: FakeCoreOptions,
    extra: Parameters<ProjectTestRunRegistry['start']>[4] = {},
    secrets?: Parameters<ProjectTestRunRegistry['start']>[3],
  ) => {
    const core = fakeCorePort(opts);
    registry.setCorePort(core.port);
    const view = registry.start(
      { projectPath: root, mode: 'run', groupId: 'gui' },
      now,
      undefined,
      secrets,
      extra,
    );
    return { core, view };
  };
  const finished = async (): Promise<NonNullable<ReturnType<ProjectTestRunRegistry['get']>>> => {
    await waitFor(() => registry.get(root)?.status !== 'running', 5000);
    return registry.get(root)!;
  };

  it('без провайдера — Claude Code: задача на месте с грантом правки, задание с границами, итог «готово»', async () => {
    const { core, view } = launch({ turn: FAKE_TURN });
    expect(view.provider).toBe('claude');
    const run = await finished();
    expect(run.status).toBe('done');
    expect(core.calls.map((c) => c.kind)).toEqual(['set-cli', 'launch', 'end-chat']);
    expect(core.calls[0]!.fields).toMatchObject({ adapter: 'claude' });
    const estimate = core.estimates[0]!;
    expect(estimate).toMatchObject({
      repos: [{ path: root, baseRef: null }],
      scenario: { preset: 'chat' },
      placement: { kind: 'in-place', grant: { project: root, ops: ['edit'] } },
    });
    expect(estimate.request).toContain(
      'Write scope of this run: writing is allowed only inside .agent/tests/',
    );
    expect(run.sessionId).toBe(core.sessions[0]);
    expect(run.tokens).toBe(122);
    expect(run.log).toContain('Гоняю кейсы.');
    expect(run.log).toContain('· Edit .agent/tests/a.json');
  });

  it.each([
    ['qwen', 'Qwen Code'],
    ['codex', 'Codex'],
  ] as const)('%s — тот же путь, переходник ядра называет set-cli', async (id, name) => {
    const { core, view } = launch({ turn: FAKE_TURN }, { provider: { id, name } });
    expect(view.provider).toBe(id);
    expect((await finished()).status).toBe('done');
    expect(core.calls[0]!.fields).toMatchObject({ scope: 'task', adapter: id });
  });

  it('отказ ядра — ошибка прогона с кодом tests-agent-core-refused и причиной ядра', async () => {
    launch(
      {
        estimate: { ok: false, code: 'repo-dirty', message: 'uncommitted changes' },
      } as FakeCoreOptions,
      { provider: { id: 'qwen', name: 'Qwen Code' } },
    );
    const run = await finished();
    expect(run.status).toBe('error');
    expect(run.messageCode).toBe('tests-agent-core-refused');
    expect(run.params).toEqual({
      provider: 'Qwen Code',
      reason: 'repo-dirty: uncommitted changes',
    });
  });

  it('отклонённый launch — отказ и снятая задача', async () => {
    const { core } = launch({
      reject: {
        launch: { cmdId: 'c', status: 'rejected', code: 'busy', reason: 'slot' } as CommandOutcome,
      },
    });
    const run = await finished();
    expect(run.status).toBe('error');
    expect(run.params).toMatchObject({ reason: 'launch busy: slot' });
    await waitFor(() => core.calls.some((c) => c.kind === 'cancel'));
  });

  it('доступы стенда — окружение задачи ядра: имя в поля оценки, значение только телом рядом; имя, которое ядро не даст, — строкой в лог', async () => {
    const { core } = launch({ turn: FAKE_TURN }, {}, () => ({
      values: { STAND_PASSWORD: 's3cret-value', NODE_OPTIONS: '--inspect' },
      missing: [{ name: 'STAND_LOGIN', title: 'логин' }],
    }));
    const run = await finished();
    expect(core.estimates[0]!.session?.env).toEqual(['STAND_PASSWORD']);
    expect(core.envs[0]).toEqual({ STAND_PASSWORD: 's3cret-value' });
    // Поля оценки уходят в журнал задачи: значения в них нет, как нет его в командах и логе.
    expect(JSON.stringify(core.estimates)).not.toContain('s3cret-value');
    expect(JSON.stringify(core.calls)).not.toContain('s3cret-value');
    expect(run.log).not.toContain('s3cret-value');
    expect(run.log).not.toContain('переменная STAND_PASSWORD в прогон не передана');
    expect(run.log).toContain('переменная NODE_OPTIONS в прогон не передана');
    expect(run.log).toContain('значения переменной STAND_LOGIN на этой машине нет (логин)');
  });

  it('границы режима — данными судье ядра: маски записи от корня и запрет команд git, двигающих историю', async () => {
    const { core } = launch({ turn: FAKE_TURN });
    await finished();
    const scope = core.estimates[0]!.session?.scope;
    expect(scope?.edit).toEqual(['.agent/tests', '.agent/tests/**']);
    expect(scope?.denyCommands).toContainEqual(['git', 'commit']);
    expect(scope?.denyCommands).toContainEqual(['git', 'push']);
    expect(scope?.denyCommands).toHaveLength(12);
  });

  it('маршрут контура из опций — set-route до запуска; без него набора ядра не трогает', async () => {
    const routes = [
      {
        adapter: 'claude',
        route: { kind: 'gateway' as const, id: 'gateway:corp' },
        modelPattern: '*',
      },
    ];
    const { core } = launch({ turn: FAKE_TURN }, { routes });
    await finished();
    expect(core.calls.map((c) => c.kind)).toEqual(['set-cli', 'set-route', 'launch', 'end-chat']);
    expect(core.calls[1]!.fields).toMatchObject({ allowedRoutes: routes });
  });

  it('запись вне границ режима и коммит за прогон — строками в лог на финише', async () => {
    launch({
      turn: FAKE_TURN,
      onLaunch: () => {
        writeFileSync(join(root, 'src', 'app.ts'), 'export const patched = 1;\n');
        writeFileSync(join(root, 'README.md'), 'x\n');
        git('add', 'README.md');
        git('commit', '-q', '-m', 'agent commit');
      },
    });
    const run = await finished();
    expect(run.status).toBe('done');
    expect(run.log).toContain(
      'за прогон тронуты файлы вне границ режима: src/app.ts — проверьте дифф',
    );
    expect(run.log).toContain('за прогон сдвинулась голова ветки');
  });

  it('запись только в каталог тестов — сверка молчит', async () => {
    launch({
      turn: FAKE_TURN,
      onLaunch: () => writeFileSync(join(root, '.agent', 'tests', 'note.json'), '{}\n'),
    });
    const run = await finished();
    expect(run.log).not.toContain('границы');
  });

  it('вопрос права от ядра — отказ за отсутствующего человека и строка в логе', async () => {
    const { core } = launch({
      hold: true,
      journal: (stepId) => [
        permitAsked(stepId, 'ask-1', 'The step needs a grant to edit ../x (Edit)'),
      ],
    });
    await waitFor(() => core.calls.some((c) => c.kind === 'answer'));
    expect(core.calls.find((c) => c.kind === 'answer')!.fields).toEqual({
      askId: 'ask-1',
      answer: 'refuse',
    });
    expect(registry.get(root)!.log).toContain(
      'права — ядро спросило «The step needs a grant to edit ../x (Edit)» — человека у прогона нет, отказано',
    );
  });

  it('«Стоп» — команда ядру cancel с причиной человека, итог «остановлен»', async () => {
    const { core } = launch({ hold: true });
    await waitFor(() => core.calls.some((c) => c.kind === 'launch'));
    expect(registry.stop(root)).toBe(true);
    expect(registry.get(root)!.status).toBe('stopped');
    await waitFor(() => core.calls.some((c) => c.kind === 'cancel'));
    expect(core.calls.find((c) => c.kind === 'cancel')!.fields).toEqual({
      reason: TESTS_CORE_STOP_REASON,
    });
  });

  describe('слой панели (G13): решатель реестра, только Claude', () => {
    const carry = {
      ok: true as const,
      carry: {
        session: { plugins: ['/kit/agentdeck-kit'], env: ['AGENTDECK_KIT_VARIANT'] },
        env: { AGENTDECK_KIT_VARIANT: 'standard' },
      },
    };

    it('отказ переноса — прогон «ошибка» с причиной, ядро не спрошено', async () => {
      registry.setLayerCarry(() => ({ ok: false, reason: 'panel flag --mcp-config refused' }));
      const { core } = launch({ turn: FAKE_TURN });
      const run = await finished();
      expect(run.status).toBe('error');
      expect(run.error).toBe('panel flag --mcp-config refused');
      expect(core.estimates).toEqual([]);
    });

    it('переменные слоя занимают места потолка: доступы стенда сверх 32 − слой — строкой в лог', async () => {
      registry.setLayerCarry(() => carry);
      const values = Object.fromEntries(
        Array.from({ length: 32 }, (_, i) => [`STAND_${String(i).padStart(2, '0')}`, 'v']),
      );
      const { core } = launch({ turn: FAKE_TURN }, {}, () => ({ values, missing: [] }));
      const run = await finished();
      expect(Object.keys(core.envs[0] ?? {})).toHaveLength(32);
      expect(core.envs[0]).toMatchObject({ AGENTDECK_KIT_VARIANT: 'standard', STAND_00: 'v' });
      expect(run.log).toContain('переменная STAND_31 в прогон не передана');
      expect(core.estimates[0]?.session?.plugins).toEqual(['/kit/agentdeck-kit']);
    });

    it('Codex — решатель не спрашивается, слоя нет', async () => {
      let asked = 0;
      registry.setLayerCarry(() => ((asked += 1), carry));
      const { core } = launch({ turn: FAKE_TURN }, { provider: { id: 'codex', name: 'Codex' } });
      await finished();
      expect(asked).toBe(0);
      expect(core.estimates[0]?.session?.plugins).toBeUndefined();
    });
  });
});
