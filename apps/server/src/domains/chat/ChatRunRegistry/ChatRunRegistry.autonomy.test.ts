import { describe, it, expect, beforeEach } from 'vitest';
import {
  AUTONOMOUS_ENV,
  autonomousPickMessage,
  type RecommendedPick,
} from '@agentdeck/contracts/chat-group-settings';
import { ChatRunRegistry, type RunLike, type RunFinished } from './ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from '../ChatRunner/ChatRunner.ts';
import { translate } from '../ChatRunner/ChatRunner.ts';

/**
 * Автономия в реестре прогонов: метка в окружении решается на каждом старте,
 * вопрос с рекомендацией не зажигает «ждёт человека», автовыбор отдаётся
 * слушателю один раз на вызов и с критичностью из тела вопроса.
 */
class FakeRun implements RunLike {
  private onEvent?: (event: ChatEvent) => void;
  private resolve?: () => void;
  options?: RunOptions;

  start(options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.options = options;
    this.onEvent = onEvent;
    return new Promise<void>((resolve) => {
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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const OPTIONS: RunOptions = { prompt: 'привет', cwd: '/tmp/x' };
const QUESTION = {
  questions: [
    {
      question: 'Удалить?',
      header: 'critical',
      options: [{ label: 'Нет' }, { label: 'Да (Recommended)' }],
    },
  ],
};
const NO_RECOMMENDATION = {
  questions: [{ question: 'Что?', options: [{ label: 'А' }, { label: 'Б' }] }],
};
/** Результат вызова так, как его пишет хук: строка `user` потока CLI. */
const resultLine = (toolUseId: string): ChatEvent[] =>
  translate({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: autonomousPickMessage([
            { question: 'Удалить?', label: 'Да (Recommended)', critical: true },
          ]),
        },
      ],
    },
  } as Parameters<typeof translate>[0]);

describe('ChatRunRegistry — автономия чата', () => {
  let runs: FakeRun[];
  let registry: ChatRunRegistry;
  let autonomous: boolean;
  let finished: RunFinished[];
  let picked: { keys: readonly string[]; picks: RecommendedPick[] }[];

  beforeEach(() => {
    runs = [];
    autonomous = true;
    finished = [];
    picked = [];
    registry = new ChatRunRegistry(() => {
      const run = new FakeRun();
      runs.push(run);
      return run;
    });
    registry.setAutonomyResolver(() => autonomous);
    registry.setAutoPickListener((keys, picks) => picked.push({ keys, picks }));
    registry.setHandoffPlanner((run) => {
      finished.push(run);
      return undefined;
    });
  });

  it('автономный старт несёт метку, выключенный — снимает даже пришедшую', () => {
    registry.start('c1', OPTIONS, {});
    expect(runs[0]?.options?.env?.[AUTONOMOUS_ENV]).toBe('1');
    runs[0]?.finish();

    autonomous = false;
    registry.start('c2', { ...OPTIONS, env: { [AUTONOMOUS_ENV]: '1', KEEP: 'x' } }, {});
    expect(runs[1]?.options?.env).toEqual({ KEEP: 'x' });
  });

  it('вопрос с рекомендацией, закрытый автовыбором, — ход не «ждёт человека»', async () => {
    registry.start('c1', OPTIONS, {});
    const run = runs[0]!;
    run.emit({ kind: 'session', sessionId: 's1', model: 'm', tools: 1 });
    run.emit({ kind: 'tool', name: 'AskUserQuestion', input: QUESTION, id: 'q1' });
    for (const event of resultLine('q1')) run.emit(event);
    run.emit({ kind: 'text', text: 'Выбрано: Да.' });
    run.finish();
    await flush();

    expect(finished[0]?.asked).toBeFalsy();
    expect(picked).toHaveLength(1);
    expect(picked[0]?.keys).toEqual(['c1', 's1']);
    // Критичность — из тела вопроса, текст отказа её не несёт.
    expect(picked[0]?.picks).toEqual([
      { question: 'Удалить?', label: 'Да (Recommended)', critical: true },
    ]);
  });

  it('ожидаемый автовыбор не случился (результат без метки) — сигнал «ждёт человека» поднимается', async () => {
    // bypass/автоподтверждение: AskUserQuestion не дошёл до prompt-tool, и
    // выбирать некому. Гасить сигнал заранее значило бы потерять вопрос молча.
    const notices: string[] = [];
    const asks: ChatEvent[] = [];
    registry.setNotifier((notice) => notices.push(notice.kind));
    registry.setAskListener((_keys, event) => asks.push(event));
    registry.start('c1', OPTIONS, {});
    const run = runs[0]!;
    run.emit({ kind: 'tool', name: 'AskUserQuestion', input: QUESTION, id: 'q1' });
    expect(notices).toEqual([]);
    run.emit({ kind: 'toolResult', toolUseId: 'q1' });
    expect(notices).toEqual(['question']);
    expect(asks.map((event) => event.kind)).toEqual(['tool']);
    run.finish();
    await flush();
    expect(finished[0]?.asked).toBe(true);
    expect(picked).toHaveLength(0);
  });

  it('ход кончился раньше результата ожидаемого автовыбора — вопрос висит', async () => {
    registry.start('c1', OPTIONS, {});
    const run = runs[0]!;
    run.emit({ kind: 'tool', name: 'AskUserQuestion', input: QUESTION, id: 'q1' });
    run.finish();
    await flush();
    expect(finished[0]?.asked).toBe(true);
  });

  it('автовыбор случился — результат вызова сигнала уже не поднимает', async () => {
    const notices: string[] = [];
    registry.setNotifier((notice) => notices.push(notice.kind));
    registry.start('c1', OPTIONS, {});
    const run = runs[0]!;
    run.emit({ kind: 'tool', name: 'AskUserQuestion', input: QUESTION, id: 'q1' });
    for (const event of resultLine('q1')) run.emit(event);
    run.finish();
    await flush();
    expect(notices).not.toContain('question');
    expect(finished[0]?.asked).toBeFalsy();
  });

  it('тот же результат дважды — один автовыбор', () => {
    registry.start('c1', OPTIONS, {});
    const run = runs[0]!;
    run.emit({ kind: 'tool', name: 'AskUserQuestion', input: QUESTION, id: 'q1' });
    for (const event of [...resultLine('q1'), ...resultLine('q1')]) run.emit(event);
    expect(picked).toHaveLength(1);
  });

  it('вопрос без рекомендации — ждёт человека и под автономией', async () => {
    registry.start('c1', OPTIONS, {});
    const run = runs[0]!;
    run.emit({ kind: 'tool', name: 'AskUserQuestion', input: NO_RECOMMENDATION, id: 'q1' });
    run.finish();
    await flush();
    expect(finished[0]?.asked).toBe(true);
    expect(picked).toHaveLength(0);
  });

  it('без автономии вопрос с рекомендацией ждёт человека', async () => {
    autonomous = false;
    registry.start('c1', OPTIONS, {});
    const run = runs[0]!;
    run.emit({ kind: 'tool', name: 'AskUserQuestion', input: QUESTION, id: 'q1' });
    run.finish();
    await flush();
    expect(finished[0]?.asked).toBe(true);
  });

  /**
   * F-141. Галочку сняли посреди хода, а процесс стартовал с меткой автономии
   * (её читает хук). Пуш «ждёт человека», ушедший до автовыбора хука, назад не
   * вернуть — сигнал откладывается до результата вызова и тогда.
   */
  it('автономию сняли посреди хода — сигнал ждёт результата, автовыбор хука его гасит', async () => {
    const notices: string[] = [];
    registry.setNotifier((notice) => notices.push(notice.kind));
    registry.start('c1', OPTIONS, {});
    const run = runs[0]!;
    autonomous = false;
    run.emit({ kind: 'tool', name: 'AskUserQuestion', input: QUESTION, id: 'q1' });
    expect(notices).toEqual([]);
    for (const event of resultLine('q1')) run.emit(event);
    run.finish();
    await flush();
    expect(notices).not.toContain('question');
    expect(finished[0]?.asked).toBeFalsy();
  });

  it('стартовал без метки и галочка снята — вопрос сигналит сразу', () => {
    const notices: string[] = [];
    registry.setNotifier((notice) => notices.push(notice.kind));
    autonomous = false;
    registry.start('c1', OPTIONS, {});
    runs[0]!.emit({ kind: 'tool', name: 'AskUserQuestion', input: QUESTION, id: 'q1' });
    expect(notices).toEqual(['question']);
  });

  /**
   * F-142. Вопрос без id автовыбором не закрыть (выбор узнаётся по id вызова),
   * а пересчёт по `askInputs` его не видел: автовыбор соседнего вопроса снимал
   * «ждёт человека» с хода, где вопрос человеку ещё висел.
   */
  it('вопрос без id не снимается автовыбором соседнего', async () => {
    registry.start('c1', OPTIONS, {});
    const run = runs[0]!;
    run.emit({ kind: 'tool', name: 'AskUserQuestion', input: NO_RECOMMENDATION, id: '' });
    run.emit({ kind: 'tool', name: 'AskUserQuestion', input: QUESTION, id: 'q1' });
    for (const event of resultLine('q1')) run.emit(event);
    run.finish();
    await flush();
    expect(picked).toHaveLength(1);
    expect(finished[0]?.asked).toBe(true);
  });

  it('isAutonomous спрашивает тот же ответ, что и старт', () => {
    registry.start('c1', OPTIONS, {});
    expect(registry.isAutonomous('c1')).toBe(true);
    autonomous = false;
    expect(registry.isAutonomous('c1')).toBe(false);
  });
});
