import { describe, expect, it } from 'vitest';
import { ChatRunRegistry, type RunLike } from '../ChatRunRegistry/ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../ChatRunner/ChatRunner.ts';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import {
  AutoContinue,
  CONTINUE_DELAYS_MS,
  CONTINUE_MAX,
  classifyEnd,
  continueNotice,
  continuePrompt,
  type ContinueDecision,
} from './auto-continue.ts';

/**
 * Продолжение обычного чата на локальной модели (L4b) — путь целиком, как его связывает
 * bootstrap: реестр прогонов → конец хода → надзор → старт ТОГО ЖЕ разговора. Подменены
 * только CLI и таймеры.
 */

class FakeRun implements RunLike {
  options?: RunOptions;
  private onEvent?: (event: ChatEvent) => void;
  private resolve?: () => void;

  start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.options = options;
    this.onEvent = onEvent;
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  stop(): void {
    this.resolve?.();
  }

  emit(event: ChatEvent): void {
    this.onEvent?.(event);
  }

  finish(): void {
    this.resolve?.();
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function harness(isLocal = true) {
  const runs: FakeRun[] = [];
  const registry = new ChatRunRegistry(() => {
    const run = new FakeRun();
    runs.push(run);
    return run;
  });
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  const decisions: Array<ContinueDecision | undefined> = [];
  const logged: string[] = [];
  const supervisor = new AutoContinue({
    start: (chatId, options, meta) => registry.start(chatId, options, meta),
    isLocal: () => isLocal,
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (handle) => {
      (handle as { cancelled: boolean }).cancelled = true;
    },
    log: (message) => logged.push(message),
  });
  registry.setStartListener((keys) => supervisor.started(keys));
  registry.setHandoffPlanner((finished) => {
    decisions.push(supervisor.finished(finished));
    return undefined;
  });
  /** Ход, оборвавшийся ошибкой. */
  const fail = async (index: number, message: string): Promise<void> => {
    runs[index]!.emit({ kind: 'error', message });
    runs[index]!.finish();
    await flush();
  };
  /** Ход, кончившийся нормально. */
  const succeed = async (index: number): Promise<void> => {
    runs[index]!.finish();
    await flush();
  };
  /** Таймеры, которые ещё не отменены. */
  const live = () => timers.filter((timer) => !timer.cancelled);
  /** Человек написал в тот же разговор. */
  const human = (text: string): boolean =>
    registry.start(
      'sess-1',
      { prompt: text, cwd: '/work', sessionId: 'sess-1' },
      { projectPath: '/work', sessionId: 'sess-1' },
    );
  return { registry, runs, timers, decisions, fail, succeed, live, logged, human };
}

function first(registry: ChatRunRegistry, runs: FakeRun[]): void {
  registry.start('chat-1', { prompt: 'Сделай задачу', cwd: '/work' }, { projectPath: '/work' });
  runs[runs.length - 1]!.emit({ kind: 'session', sessionId: 'sess-1', model: 'qwen', tools: 1 });
}

describe('продолжение чата на локальной модели — через реестр', () => {
  it('сеть оборвалась: через паузу в ТОТ ЖЕ разговор уходит «продолжай с места остановки»', async () => {
    const { registry, runs, decisions, fail, live } = harness();
    first(registry, runs);
    await fail(0, 'API Error: fetch failed');

    expect(decisions[0]).toMatchObject({
      continuing: true,
      attempt: 1,
      delayMs: CONTINUE_DELAYS_MS[0],
    });
    expect(live().map((timer) => timer.ms)).toEqual([CONTINUE_DELAYS_MS[0]]);
    live()[0]!.run();
    expect(runs[1]?.options).toMatchObject({
      sessionId: 'sess-1',
      cwd: '/work',
      prompt: continuePrompt('API Error: fetch failed'),
    });
    expect(runs[1]?.options?.prompt).toContain('.agent/PROGRESS.md');
    expect(runs[1]?.options?.prompt).toContain('[Автоматически]');
  });

  it('счёт ограничен: после CONTINUE_MAX продолжений — «нужен человек», паузы растут', async () => {
    const { registry, runs, decisions, fail, live } = harness();
    first(registry, runs);
    await fail(0, 'overloaded_error');
    for (let attempt = 1; attempt <= CONTINUE_MAX; attempt += 1) {
      expect(live().at(-1)?.ms).toBe(CONTINUE_DELAYS_MS[attempt - 1]);
      live().at(-1)!.run();
      await fail(runs.length - 1, 'overloaded_error');
    }
    expect(decisions.at(-1)).toMatchObject({ continuing: false, attempts: CONTINUE_MAX });
    // Больше продолжений нет: после последнего неотменённых таймеров не прибавилось.
    expect(live()).toHaveLength(CONTINUE_MAX);
    expect(runs).toHaveLength(1 + CONTINUE_MAX);
  });

  it('слово человека снимает ждущее продолжение и обнуляет счёт', async () => {
    const { registry, runs, fail, live, decisions, human } = harness();
    first(registry, runs);
    await fail(0, 'overloaded_error');
    expect(live()).toHaveLength(1);
    // Человек написал сам — ждущее продолжение не нужно: иначе два агента на один разговор.
    expect(human('я сам')).toBe(true);
    expect(live()).toHaveLength(0);
    await fail(1, 'overloaded_error');
    // Счёт начат заново: снова первая попытка, а не вторая.
    expect(decisions.at(-1)).toMatchObject({ continuing: true, attempt: 1 });
  });

  it('собственное продолжение счёт не обнуляет', async () => {
    const { registry, runs, fail, live, decisions } = harness();
    first(registry, runs);
    await fail(0, 'socket hang up');
    live()[0]!.run();
    await fail(1, 'socket hang up');
    expect(decisions.at(-1)).toMatchObject({ continuing: true, attempt: 2 });
  });

  it('нормальный конец — продолжения нет', async () => {
    const { registry, runs, decisions, live, succeed } = harness();
    first(registry, runs);
    await succeed(0);
    expect(decisions[0]).toBeUndefined();
    expect(live()).toHaveLength(0);
  });

  it('удачный ход обнуляет счёт', async () => {
    const { registry, runs, decisions, fail, live, succeed, human } = harness();
    first(registry, runs);
    await fail(0, 'overloaded_error');
    live()[0]!.run();
    await succeed(1);
    human('ещё');
    await fail(2, 'overloaded_error');
    expect(decisions.at(-1)).toMatchObject({ continuing: true, attempt: 1 });
  });

  it('не локальный чат (облако): продолжения нет вовсе', async () => {
    const { registry, runs, decisions, fail, live } = harness(false);
    first(registry, runs);
    await fail(0, 'API Error: fetch failed');
    expect(decisions[0]).toBeUndefined();
    expect(live()).toHaveLength(0);
  });

  it('ошибка по существу (ключ) не продолжается', async () => {
    const { registry, runs, decisions, fail, live } = harness();
    first(registry, runs);
    await fail(0, 'Invalid API key');
    expect(decisions[0]).toBeUndefined();
    expect(live()).toHaveLength(0);
  });

  it('разговор уже занят к моменту таймера — старт отказан и записан в журнал', async () => {
    const { registry, runs, fail, live, logged } = harness();
    first(registry, runs);
    await fail(0, 'overloaded_error');
    const timer = live()[0]!;
    // Гонка: чужой старт занял разговор, а таймер этого не заметил.
    registry.start(
      'chat-1',
      { prompt: 'другой', cwd: '/work' },
      { projectPath: '/work', sessionId: 'sess-1' },
    );
    timer.run();
    expect(logged).toContain('auto continue: start refused');
  });
});

describe('classifyEnd', () => {
  const base = { ok: false, text: '', asked: false };

  it('лечится: сеть, 5xx, перегрузка, смерть процесса, повторы, буксующее сжатие, предел вывода, окно', () => {
    for (const error of [
      'API Error: fetch failed',
      'API Error: 503 upstream',
      'Repeated 529 Overloaded errors',
      'claude завершился с кодом 1',
      serverText('chat-process-lost'),
      'Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row',
      "API Error: Claude's response exceeded the 8192 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.",
      'The model has reached its context window limit',
      'Prompt is too long',
    ]) {
      expect(classifyEnd({ ...base, error }), error).toMatchObject({ recoverable: true });
    }
  });

  it('не лечится: нормальный конец, вопрос, по существу, пустая ошибка', () => {
    expect(classifyEnd({ ...base, ok: true, error: 'x' }).recoverable).toBe(false);
    expect(classifyEnd({ ...base, asked: true, error: 'fetch failed' }).recoverable).toBe(false);
    expect(classifyEnd({ ...base, error: 'Invalid API key' }).recoverable).toBe(false);
    expect(
      classifyEnd({ ...base, error: 'Не удалось запустить «claude»: ENOENT' }).recoverable,
    ).toBe(false);
    expect(classifyEnd({ ...base }).recoverable).toBe(false);
  });

  it('модель закончила вопросом и ход упал — ждёт человека, а не «продолжай»', () => {
    expect(
      classifyEnd({ ...base, error: 'fetch failed', text: 'Какой файл править?' }).recoverable,
    ).toBe(false);
  });
});

describe('текст в ленту', () => {
  it('продолжение — с числами попытки; исчерпано — другим кодом', () => {
    const go = continueNotice({
      continuing: true,
      attempt: 2,
      delayMs: 60_000,
      reason: 'fetch failed',
    });
    expect(go).toMatchObject({ code: 'autoContinue', textCode: 'chat-auto-continue-notice' });
    expect(serverText(go.textCode, go.params)).toContain('2 из 3');
    const spent = continueNotice({ continuing: false, attempts: 3, reason: 'fetch failed' });
    expect(spent.code).toBe('autoContinueSpent');
    expect(serverText(spent.textCode, spent.params)).toContain('нужен человек');
  });
});

describe('продолжение — доводка после ревью L4b (L4c)', () => {
  const base = { ok: false, text: '', asked: false };

  it('обрыв усыновлённого локального прогона лечится продолжением (ночью процесс не остаётся без присмотра)', () => {
    expect(classifyEnd({ ...base, interrupted: true }).recoverable).toBe(true);
    expect(classifyEnd({ ...base, interrupted: true, error: 'fetch failed' })).toMatchObject({
      recoverable: true,
    });
  });

  it('продолжение не наследует fork: упавший первый ход ветки возобновляет сессию, а не ветвит снова', async () => {
    const { registry, runs, fail, live } = harness();
    registry.start(
      'chat-1',
      { prompt: 'задача', cwd: '/work', fork: true },
      { projectPath: '/work' },
    );
    runs[0]!.emit({ kind: 'session', sessionId: 'sess-1', model: 'qwen', tools: 1 });
    await fail(0, 'API Error: fetch failed');
    live()[0]!.run();
    expect(runs[1]?.options?.sessionId).toBe('sess-1');
    expect(runs[1]?.options?.fork).toBeFalsy();
  });

  it('продолжение сделало работу (инструменты исполнялись) — счёт начинается заново', async () => {
    const { registry, runs, fail, live, decisions } = harness();
    first(registry, runs);
    await fail(0, 'overloaded_error');
    for (let round = 1; round <= CONTINUE_MAX + 2; round += 1) {
      live().at(-1)!.run();
      const index = runs.length - 1;
      // Ход шёл часами: инструменты исполнялись, и только потом сеть оборвалась.
      for (let step = 0; step < 5; step += 1) {
        runs[index]!.emit({ kind: 'toolResult', toolUseId: `t${round}-${step}` });
      }
      await fail(index, 'overloaded_error');
      expect(decisions.at(-1), `раунд ${round}`).toMatchObject({ continuing: true, attempt: 1 });
    }
  });

  it('продолжение почти ничего не сделало — счёт идёт к пределу как раньше', async () => {
    const { registry, runs, fail, live, decisions } = harness();
    first(registry, runs);
    await fail(0, 'overloaded_error');
    live().at(-1)!.run();
    runs[1]!.emit({ kind: 'toolResult', toolUseId: 'only-one' });
    await fail(1, 'overloaded_error');
    expect(decisions.at(-1)).toMatchObject({ continuing: true, attempt: 2 });
  });

  it('ход, за которым планировщик назначил своё продолжение, таймера не заводит', () => {
    const timers: unknown[] = [];
    const supervisor = new AutoContinue({
      start: () => true,
      isLocal: () => true,
      schedule: (run, ms) => timers.push({ run, ms }),
      log: () => undefined,
    });
    const finished = {
      chatId: 'c',
      sessionId: 's',
      text: '',
      ok: false,
      startedAt: 0,
      options: { prompt: 'x', cwd: '/w' },
      contextTokens: 0,
      error: 'fetch failed',
    };
    expect(supervisor.finished(finished, true)).toBeUndefined();
    expect(timers).toHaveLength(0);
    expect(supervisor.finished(finished)).toMatchObject({ continuing: true });
    expect(timers).toHaveLength(1);
  });
});
