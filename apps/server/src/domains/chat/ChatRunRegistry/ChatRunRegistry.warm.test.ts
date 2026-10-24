import { describe, expect, it } from 'vitest';
import { ChatRunRegistry, type RunLike } from './ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../ChatRunner/ChatRunner.ts';

/**
 * Пинг тёплого кэша (`warm`) обязан греть ТОТ кэш, который прочитает следующий
 * ход группы: его параметры собираются той же сборкой (`compose`), что и ход, —
 * маршрут контура, профиль группы, слои, снятые инструменты, метка автономии.
 * Разница — только в том, что делает пинг пингом. И пинг не ход разговора: ни
 * записи прогона, ни сторожа, ни журнала, ни решения о продолжении, ни
 * включения группы. Подменён только процесс.
 */

class FakeRun implements RunLike {
  pid = 4242;
  options?: RunOptions;
  stopped = 0;
  private resolve?: () => void;
  private readonly script: (emit: (event: ChatEvent) => void) => boolean;
  constructor(script: (emit: (event: ChatEvent) => void) => boolean = () => true) {
    this.script = script;
  }
  start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.options = options;
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
      // Сценарий вернул true — ход кончился сам; иначе ждёт stop().
      if (this.script(onEvent)) queueMicrotask(resolve);
    });
  }
  stop(): void {
    this.stopped += 1;
    this.resolve?.();
  }
}

const PERMISSION = { runId: 'child-1', baseUrl: 'http://127.0.0.1:5178' };

/** Реестр со всеми решениями «на каждом старте», от которых зависит префикс. */
function wired(script?: (emit: (event: ChatEvent) => void) => boolean) {
  const runs: FakeRun[] = [];
  const registry = new ChatRunRegistry(() => {
    const run = new FakeRun(script);
    runs.push(run);
    return run;
  });
  registry.setPlatformRouting(() => ({
    env: { ROUTE: 'gw' },
    systemPrompt: 'contour prompt',
  }));
  registry.setChildResolver(() => true);
  registry.setGroupProfileResolver(() => ({
    args: ['--strict-mcp-config'],
    env: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
    note: 'profile note',
    settings: { skillOverrides: { a: 'name-only' } },
  }));
  registry.setWorkspaceNote(() => 'workspace note');
  registry.setWorkspaceEnv(() => ({ QA: '1' }));
  registry.setDeniedToolsResolver(() => ['NotebookEdit']);
  registry.setAutonomyResolver(() => true);
  registry.setChildrenBriefResolver(() => 'children brief');
  return { registry, runs };
}

/** То, чем пинг отличается от хода по замыслу; всё остальное обязано совпасть. */
function prefix(options: RunOptions): Record<string, unknown> {
  const {
    prompt: _prompt,
    fork: _fork,
    ephemeral: _ephemeral,
    sessionId: _sessionId,
    name: _name,
    denyTools: _denyTools,
    permissionPrompt,
    ...rest
  } = options;
  return { ...rest, permissionPrompt: { ...permissionPrompt, runId: '' } };
}

const turn: RunOptions = {
  prompt: 'продолжай работу',
  cwd: '/work/copy',
  sessionId: 's1',
  model: 'opus',
  effort: 'high',
  permissionMode: 'acceptEdits',
  appendSystemPrompt: 'split append',
  permissionPrompt: PERMISSION,
  name: 'Группа 1',
};

describe('ChatRunRegistry.warm — префикс пинга', () => {
  it('параметры пинга совпадают с ходом группы, кроме слова, ответвления и следа', async () => {
    const { registry, runs } = wired();
    registry.start('child-1', turn, { origin: 'chat', sessionId: 's1' });
    const outcome = await registry.warm(
      ['child-1', 's1'],
      's1',
      turn,
      { origin: 'chat' },
      'ping-word',
    );
    expect(outcome.ok).toBe(true);
    expect(runs).toHaveLength(2);
    const work = runs[0]?.options as RunOptions;
    const ping = runs[1]?.options as RunOptions;
    expect(prefix(ping)).toEqual(prefix(work));
    // Решения «на каждом старте» действительно дошли и до пинга — сравнение не пустое.
    expect(ping.platformEnv).toMatchObject({ ROUTE: 'gw', QA: '1' });
    expect(ping.platformArgs).toContain('--strict-mcp-config');
    expect(ping.deniedTools).toEqual(['NotebookEdit']);
    expect(ping.workspaceNote).toBe('workspace note');
    // Что делает пинг пингом.
    expect(ping).toMatchObject({
      prompt: 'ping-word',
      sessionId: 's1',
      fork: true,
      ephemeral: true,
      denyTools: true,
      permissionPrompt: { runId: 'keep-warm-s1' },
    });
    expect(work.denyTools).toBeUndefined();
    expect(ping.name).toBeUndefined();
    // Сводка детей — ходу человека, а не пингу.
    expect(work.prompt).toContain('children brief');
    expect(ping.prompt).not.toContain('children brief');
  });
});

describe('ChatRunRegistry.latestRunOf — параметры пинга', () => {
  it('первый ход группы ещё идёт (стоит на разрешении) — его параметры, не принятые', () => {
    const { registry } = wired((emit) => {
      emit({ kind: 'session', sessionId: 's1' } as ChatEvent);
      return false;
    });
    expect(registry.latestRunOf(['child-1'])).toBeUndefined();
    registry.start('child-1', turn, { origin: 'chat' });
    const latest = registry.latestRunOf(['child-1']);
    expect(latest).toMatchObject({ chatId: 'child-1', sessionId: 's1' });
    expect(latest?.options.appendSystemPrompt).toBe('split append');
    expect(latest?.adopted).toBeUndefined();
  });
});

describe('ChatRunRegistry.warm — пинг не ход разговора', () => {
  it('ни записи прогона, ни сторожа, ни журналов хода, ни продолжения, ни группы; трата — в журнал лимита с меткой', async () => {
    const { registry } = wired((emit) => {
      emit({ kind: 'session', sessionId: 'fork-1' } as ChatEvent);
      emit({
        kind: 'usage',
        input: 3,
        output: 2,
        cacheRead: 36_000,
        cacheCreation: 350,
        cacheCreation1h: 350,
      } as ChatEvent);
      return true;
    });
    const touched: string[] = [];
    registry.setWatchListener(() => touched.push('watch'));
    registry.setStartListener(() => touched.push('start'));
    registry.setSessionListener(() => touched.push('session'));
    registry.setInputJournal(() => touched.push('input'));
    const limitRecords: unknown[] = [];
    registry.setLimitJournal((record) => {
      touched.push('limit');
      limitRecords.push(record);
    });
    registry.setGroupActivation(() => {
      touched.push('activation');
      return undefined;
    });
    registry.setContinuationPolicy(() => {
      touched.push('continuation');
      return undefined;
    });
    registry.setLedger({
      upsert: () => touched.push('ledger'),
      remove: () => touched.push('ledger'),
      read: () => [],
    } as never);
    const outcome = await registry.warm(['child-1', 's1'], 's1', turn, { origin: 'chat' }, 'w');
    expect(outcome).toMatchObject({
      ok: true,
      sessionId: 'fork-1',
      usage: { input: 3, output: 2, cacheRead: 36_000, cacheWrite: 350, cacheWrite1h: 350 },
    });
    // Пинг тратит окно подписки — его доля пишется группе, с меткой пинга.
    expect(touched).toEqual(['limit']);
    expect(limitRecords).toEqual([
      expect.objectContaining({
        chatId: 'child-1',
        sessionId: 's1',
        source: 'keep-warm',
        tokens: 3 + 2 + 36_000 + 350,
      }),
    ]);
    touched.length = 0;
    expect(registry.has('child-1')).toBe(false);
    expect(registry.has('s1')).toBe(false);
    expect(registry.has('fork-1')).toBe(false);
    // Контроль: обычный ход тех же слушателей задевает — проверка умеет краснеть.
    registry.start('child-1', turn, { origin: 'chat', sessionId: 's1' });
    expect(touched).toEqual(expect.arrayContaining(['watch', 'start', 'continuation']));
  });

  it('вызов инструмента обрывает пинг', async () => {
    const { registry, runs } = wired((emit) => {
      emit({ kind: 'tool', id: 't1', name: 'Bash', input: {} } as unknown as ChatEvent);
      return false;
    });
    const outcome = await registry.warm(['child-1'], 's1', turn, { origin: 'chat' }, 'w');
    expect(runs[0]?.stopped).toBe(1);
    expect(outcome).toMatchObject({ ok: false, toolStopped: true });
  });

  it('«Остановить всё» гасит и идущий пинг', async () => {
    const { registry, runs } = wired(() => false);
    const pending = registry.warm(['child-1'], 's1', turn, { origin: 'chat' }, 'w');
    expect(runs).toHaveLength(1);
    registry.stopAll();
    expect(runs[0]?.stopped).toBe(1);
    await expect(pending).resolves.toMatchObject({ ok: true });
    // Законченный пинг из списка гасимых ушёл: второй stopAll его не трогает.
    registry.stopAll();
    expect(runs[0]?.stopped).toBe(1);
  });

  it('выход сервера (detachAll) пинг не отпускает посредником, а гасит', async () => {
    const { registry, runs } = wired(() => false);
    const pending = registry.warm(['child-1'], 's1', turn, { origin: 'chat' }, 'w');
    registry.detachAll();
    expect(runs[0]?.stopped).toBe(1);
    await pending;
  });

  it('без сессии и при отказе контура процесс не поднимается', async () => {
    const { registry, runs } = wired();
    await expect(
      registry.warm(['child-1'], '', turn, { origin: 'chat' }, 'w'),
    ).resolves.toMatchObject({ ok: false, error: 'no-session' });
    registry.setPlatformRouting(() => ({ env: {}, refusal: 'контур недоступен' }));
    await expect(
      registry.warm(['child-1'], 's1', turn, { origin: 'chat' }, 'w'),
    ).resolves.toMatchObject({ ok: false, error: 'контур недоступен' });
    expect(runs).toHaveLength(0);
  });

  it('бюджет контура исчерпан — пинг не уходит (ревью K)', async () => {
    const { registry, runs } = wired();
    registry.setPlatformRouting(() => ({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:5179/c/_s/chat' },
      budgetExhausted: true,
    }));
    await expect(
      registry.warm(['child-1'], 's1', turn, { origin: 'chat' }, 'w'),
    ).resolves.toMatchObject({
      ok: false,
      error: 'contour-budget-exhausted',
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0 },
    });
    expect(runs).toHaveLength(0);
  });
});
