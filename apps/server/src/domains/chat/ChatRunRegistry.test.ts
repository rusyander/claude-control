import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ChatRunRegistry,
  type RunLike,
  type BufferedEvent,
  type RunSubscriber,
} from './ChatRunRegistry.ts';
import type { ChatEvent, RunOptions } from './ChatRunner.ts';
import type { LoweredRunRecord } from '@agentdeck/contracts/model-cascade';

/**
 * Реестр прогонов, отвязанный от HTTP-запроса. Настоящий CLI не запускаем —
 * подставляем управляемый фейк и проверяем ровно то, ради чего реестр появился:
 * события копятся с порядковыми номерами, к прогону можно подключиться и
 * переподключиться, догнав пропущенное, а обрыв соединения агента не убивает.
 * Тест-кейсы см. .agent/TEST-CASES.md → «Реестр прогонов чата».
 */

/** Управляемый прогон: сами шлём события и сами завершаем. */
class FakeRun implements RunLike {
  private onEvent?: (event: ChatEvent) => void;
  private resolve?: () => void;
  stopped = false;

  start(_options: RunOptions, onEvent: (event: ChatEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    return new Promise<void>((resolve) => {
      this.resolve = resolve;
    });
  }

  stop(): void {
    this.stopped = true;
    this.resolve?.();
  }

  /** Прислать событие как настоящий CLI. */
  emit(event: ChatEvent): void {
    this.onEvent?.(event);
  }

  /** Процесс закрылся сам (без остановки). */
  finish(): void {
    this.resolve?.();
  }
}

/** Слушатель-накопитель: собирает события и факт закрытия. */
function collector() {
  const events: BufferedEvent[] = [];
  const state = { closed: false };
  const sub: RunSubscriber = {
    send: (buffered) => events.push(buffered),
    close: () => {
      state.closed = true;
    },
  };
  return { events, state, sub };
}

/** Дать сработать микрозадаче `.then` после завершения фейка. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const OPTIONS: RunOptions = { prompt: 'привет', cwd: '/tmp/x' };
const SESSION: ChatEvent = { kind: 'session', sessionId: 'sess-1', model: 'm', tools: 1 };

describe('ChatRunRegistry', () => {
  let fake: FakeRun;
  let registry: ChatRunRegistry;

  beforeEach(() => {
    fake = new FakeRun();
    registry = new ChatRunRegistry(() => fake);
  });

  it('догоняет буфер и слушает живые события, seq растут монотонно', () => {
    registry.start('c1', OPTIONS, {});
    fake.emit(SESSION);
    fake.emit({ kind: 'text', text: 'при' });

    const { events, sub } = collector();
    const unsubscribe = registry.attach('c1', 0, sub);

    // Догнали буфер целиком.
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    expect(events[0]?.event.kind).toBe('session');

    // Живое событие приходит следующим номером.
    fake.emit({ kind: 'text', text: 'вет' });
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(typeof unsubscribe).toBe('function');
  });

  it('переподключение с seq отдаёт только новое', () => {
    registry.start('c1', OPTIONS, {});
    fake.emit(SESSION); // seq 1
    fake.emit({ kind: 'text', text: 'а' }); // seq 2
    fake.emit({ kind: 'text', text: 'б' }); // seq 3

    const { events, sub } = collector();
    registry.attach('c1', 2, sub); // догоняем начиная с 3-го
    expect(events.map((e) => e.seq)).toEqual([3]);
  });

  it('active() перечисляет идущий прогон с sessionId и projectPath', () => {
    registry.start('c1', OPTIONS, { projectPath: '/proj' });
    fake.emit(SESSION);

    const active = registry.active();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      chatId: 'c1',
      sessionId: 'sess-1',
      projectPath: '/proj',
      status: 'running',
    });
    expect(active[0]?.finishedAt).toBeUndefined();
  });

  // Вкладка, не заводившая прогон (F5, телефон, дети разделения), своей записи
  // о модели не имеет: с подбором модели под задачу пульт агентов без этого
  // поля показывает несколько неотличимых строк.
  it('active() называет модель прогона, а «как решит CLI» полем не засоряет', () => {
    registry.start('c1', { ...OPTIONS, model: 'claude-sonnet-5' }, {});
    registry.start('c2', OPTIONS, {});

    const active = registry.active();
    expect(active.find((info) => info.chatId === 'c1')?.model).toBe('claude-sonnet-5');
    expect(active.find((info) => info.chatId === 'c2')).not.toHaveProperty('model');
  });

  it('завершение закрывает живых слушателей, но буфер живёт для догона', async () => {
    registry.start('c1', OPTIONS, {});
    const live = collector();
    registry.attach('c1', 0, live.sub);

    fake.emit({ kind: 'text', text: 'ответ' });
    fake.emit({ kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-1' });
    fake.finish();
    await flush();

    // Живого слушателя закрыли, прогон больше не идёт.
    expect(live.state.closed).toBe(true);
    expect(registry.isRunning('c1')).toBe(false);

    // Догон в пределах grace возвращает буфер (включая done) и «нет живого потока».
    const late = collector();
    const unsubscribe = registry.attach('c1', 0, late.sub);
    expect(unsubscribe).toBeUndefined();
    expect(late.events.some((e) => e.event.kind === 'done')).toBe(true);
  });

  it('ошибка помечает прогон как завершённый и убирает из active()', async () => {
    registry.start('c1', OPTIONS, {});
    fake.emit({ kind: 'error', message: 'лимит' });
    fake.finish();
    await flush();

    expect(registry.isRunning('c1')).toBe(false);
    expect(registry.active()).toHaveLength(0);
  });

  it('stop убивает прогон и убирает его из реестра', () => {
    registry.start('c1', OPTIONS, {});
    expect(registry.isRunning('c1')).toBe(true);

    const ok = registry.stop('c1');
    expect(ok).toBe(true);
    expect(fake.stopped).toBe(true);
    expect(registry.has('c1')).toBe(false);
  });

  it('повторный start при идущем прогоне не плодит второй процесс', () => {
    let created = 0;
    const reg = new ChatRunRegistry(() => {
      created += 1;
      return new FakeRun();
    });
    reg.start('c1', OPTIONS, {});
    reg.start('c1', OPTIONS, {});
    expect(created).toBe(1);
  });

  // Регрессия: раньше `start` при идущем прогоне просто выходил, и маршрут
  // подключал человека к ЧУЖОМУ прогону — его сообщение пропадало молча.
  it('start при идущем прогоне возвращает false, а после завершения — true', async () => {
    const runs: FakeRun[] = [];
    const reg = new ChatRunRegistry(() => {
      const run = new FakeRun();
      runs.push(run);
      return run;
    });

    expect(reg.start('c1', OPTIONS, {})).toBe(true);
    expect(reg.start('c1', { ...OPTIONS, prompt: 'второе сообщение' }, {})).toBe(false);
    // Второй промпт до прогона не дошёл — процесс всё тот же, первый.
    expect(runs.length).toBe(1);

    runs[0]!.finish();
    await flush();

    expect(reg.start('c1', { ...OPTIONS, prompt: 'второе сообщение' }, {})).toBe(true);
    expect(runs.length).toBe(2);
  });

  it('нет прогона — attach и has() это видят', () => {
    expect(registry.has('нет')).toBe(false);
    const { sub } = collector();
    expect(registry.attach('нет', 0, sub)).toBeUndefined();
  });
});

/**
 * Маршрут контура (Т3) со стороны реестра: кого он спрашивает, что кладёт в
 * параметры прогона и что рассказывает о завершившемся.
 *
 * Проверяется здесь потому, что происхождение прогона выбирается ИМЕННО тут:
 * работа группы, у которой оно потерялось, спрашивала маршрут как «чат» — то
 * есть меняла провайдера посреди цепочки, и ни один тест этого не видел.
 */
describe('ChatRunRegistry — происхождение прогона и маршрут контура', () => {
  let fake: FakeRun;
  let registry: ChatRunRegistry;
  const asked: string[] = [];

  beforeEach(() => {
    asked.length = 0;
    fake = new FakeRun();
    registry = new ChatRunRegistry(() => fake);
    registry.setPlatformRouting((origin) => {
      asked.push(origin);
      const env: Record<string, string> =
        origin === 'groups' ? { ANTHROPIC_BASE_URL: 'http://127.0.0.1:5179/contour' } : {};
      return { env };
    });
  });

  it('маршрут спрашивается происхождением из меты, а не «чатом» по умолчанию', () => {
    registry.start('c1', OPTIONS, { origin: 'groups' });
    expect(asked).toEqual(['groups']);
    expect(registry.describe('c1')?.options.platformEnv).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:5179/contour',
    });
  });

  it('происхождения нет — спрашивается «чат», и адрес прошлой жизни затирается', () => {
    registry.start(
      'c2',
      { ...OPTIONS, platformEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/stale' } },
      {},
    );
    expect(asked).toEqual(['chat']);
    expect(registry.describe('c2')?.options.platformEnv).toEqual({});
  });

  /**
   * Слои Т8 со стороны реестра. Дописку панели (инициативы, разделение,
   * продолжение) собирает маршрут чата, который про контур не знает ничего, —
   * значит, снять её может только это место. Не снятая, она пережила бы
   * снятую галочку и уезжала бы в контур на каждом сообщении.
   */
  it('снятые слои кладутся флагами, а наша дописка к промпту снимается тут же', () => {
    registry.setPlatformRouting(() => ({
      env: {},
      layers: { args: ['--setting-sources', 'project,local'], systemPrompt: false, dropped: [] },
    }));

    registry.start('c4', { ...OPTIONS, appendSystemPrompt: 'инициатива панели' }, {});
    const options = registry.describe('c4')?.options;
    expect(options?.platformArgs).toEqual(['--setting-sources', 'project,local']);
    expect(options?.platformDropAppend).toBe(true);
    // Сам ТЕКСТ дописки при этом цел: снимает его запуск, а снимок параметров
    // переживает паузу дерева и перезапуск панели.
    expect(options?.appendSystemPrompt).toBe('инициатива панели');
  });

  it('маршрута нет — флагов нет, и дописка панели остаётся как была', () => {
    registry.start('c5', { ...OPTIONS, appendSystemPrompt: 'инициатива панели' }, {});
    const options = registry.describe('c5')?.options;
    expect(options?.platformArgs).toEqual([]);
    expect(options?.platformDropAppend).toBe(false);
    expect(options?.appendSystemPrompt).toBe('инициатива панели');
  });

  /**
   * Ревью Т8, MAJOR-4. Прогон с паузой дерева продолжают СОХРАНЁННЫМИ
   * параметрами, и до правки в них лежала пустая дописка: человек снимал слой,
   * ставил дерево на паузу, возвращал галочку — и продолжение уходило без
   * инициатив, разделения и продолжения сессии, а шапка чата в этот момент
   * честно молчала, снятых слоёв уже не было.
   */
  it('снятый и возвращённый слой не съедает дописку у продолженного прогона', () => {
    registry.setPlatformRouting(() => ({
      env: {},
      layers: { args: ['--strict-mcp-config'], systemPrompt: false, dropped: ['systemPrompt'] },
    }));
    registry.start('c6', { ...OPTIONS, appendSystemPrompt: 'инициатива панели' }, {});
    const paused = registry.describe('c6')?.options;
    expect(paused?.platformDropAppend).toBe(true);

    // Галочку вернули — и продолжение стартует ТЕМ ЖЕ снимком параметров.
    registry.setPlatformRouting(() => ({
      env: {},
      layers: { args: [], systemPrompt: true, dropped: [] },
    }));
    registry.start('c7', { ...paused! }, {});
    const resumed = registry.describe('c7')?.options;
    expect(resumed?.platformDropAppend).toBe(false);
    expect(resumed?.appendSystemPrompt).toBe('инициатива панели');
  });

  it('завершившийся прогон рассказывает планировщику своё происхождение', async () => {
    const seen: (string | undefined)[] = [];
    registry.setHandoffPlanner((finished) => {
      seen.push(finished.origin);
      return undefined;
    });

    registry.start('c3', OPTIONS, { origin: 'groups' });
    fake.finish();
    await flush();

    // Без этого звено конвейера и продолжение в чистой сессии заводились бы
    // «чатом»: они собирают свою мету от ЭТОГО прогона.
    expect(seen).toEqual(['groups']);
  });
});

/**
 * Счётчик расхода за сеанс сервера. Ключевое (по ТЗ): накопление идёт на
 * сервере (переживает F5 вкладки), а переподключение с догоном буфера НЕ должно
 * считать токены/деньги повторно — накопление привязано к генерации события, а
 * не к его доставке слушателю.
 */
describe('ChatRunRegistry — счётчик расхода (spend)', () => {
  let fake: FakeRun;
  let registry: ChatRunRegistry;

  beforeEach(() => {
    fake = new FakeRun();
    registry = new ChatRunRegistry(() => fake);
  });

  const USAGE: ChatEvent = {
    kind: 'usage',
    input: 10,
    output: 20,
    cacheRead: 5,
    cacheCreation: 3,
  };
  const DONE = (costUsd: number): ChatEvent => ({
    kind: 'done',
    costUsd,
    durationMs: 1,
    sessionId: 'sess-1',
  });

  it('стартовый расход — нули', () => {
    expect(registry.spend()).toEqual({ costUsd: 0, tokens: 0 });
  });

  it('usage складывает все виды токенов, done — стоимость', () => {
    registry.start('c1', OPTIONS, {});
    fake.emit(USAGE); // 10+20+5+3 = 38
    fake.emit(DONE(0.25));

    expect(registry.spend()).toEqual({ costUsd: 0.25, tokens: 38 });
  });

  it('переподключение с догоном буфера НЕ удваивает расход', () => {
    registry.start('c1', OPTIONS, {});
    fake.emit(USAGE);
    fake.emit(DONE(0.25));

    const before = registry.spend();
    // Клиент переподключается и догоняет весь буфер с seq 0 — как после F5.
    const { sub } = collector();
    registry.attach('c1', 0, sub);

    // Повторная доставка тех же событий расход не меняет.
    expect(registry.spend()).toEqual(before);
  });

  it('несколько прогонов складываются в общий счётчик сеанса', () => {
    // Фабрика выдаёт свежий прогон на каждый chatId — держим ссылки, чтобы слать
    // события в нужный прогон.
    const byId = new Map<string, FakeRun>();
    let next: FakeRun;
    const reg = new ChatRunRegistry(() => {
      next = new FakeRun();
      return next;
    });

    reg.start('c1', OPTIONS, {});
    byId.set('c1', next!);
    reg.start('c2', OPTIONS, {});
    byId.set('c2', next!);

    byId.get('c1')!.emit(USAGE); // 38 токенов
    byId.get('c1')!.emit(DONE(0.1));
    byId.get('c2')!.emit(USAGE); // ещё 38 токенов
    byId.get('c2')!.emit(DONE(0.4));

    expect(reg.spend().tokens).toBe(76);
    expect(reg.spend().costUsd).toBeCloseTo(0.5, 5);
  });

  const ERROR: ChatEvent = { kind: 'error', message: 'сеть моргнула' };

  it('ретрай поверх упавшего прогона НЕ задваивает расход', async () => {
    // Свежий прогон на каждый start: упавшая попытка и её ретрай — разные процессы.
    const created: FakeRun[] = [];
    const reg = new ChatRunRegistry(() => {
      const run = new FakeRun();
      created.push(run);
      return run;
    });

    // Первая попытка: потратила токены и упала (done не пришёл — только error).
    reg.start('c1', OPTIONS, {});
    created[0]!.emit(USAGE); // 38 токенов уже осели в счётчике
    created[0]!.emit(ERROR);
    created[0]!.finish();
    await flush();
    expect(reg.spend().tokens).toBe(38);

    // Ретрай тем же chatId: вклад упавшей попытки откатывается перед повтором,
    // иначе её токены остались бы в счётчике и ретрай добавил бы ещё столько же.
    reg.start('c1', OPTIONS, {});
    expect(reg.spend()).toEqual({ costUsd: 0, tokens: 0 });

    // Повтор отработал успешно — считаем ровно его расход, без задвоения.
    created[1]!.emit(USAGE); // снова 38
    created[1]!.emit(DONE(0.25));
    created[1]!.finish();
    await flush();
    expect(reg.spend()).toEqual({ costUsd: 0.25, tokens: 38 });
  });

  it('новый ход поверх УСПЕШНОГО прогона расход НЕ теряет', async () => {
    // Обратная сторона отката: состоявшийся ход — не отменённая попытка, его
    // расход при следующем сообщении в том же чате обязан сохраниться.
    const created: FakeRun[] = [];
    const reg = new ChatRunRegistry(() => {
      const run = new FakeRun();
      created.push(run);
      return run;
    });

    reg.start('c1', OPTIONS, {});
    created[0]!.emit(USAGE);
    created[0]!.emit(DONE(0.1));
    created[0]!.finish();
    await flush();
    expect(reg.spend()).toEqual({ costUsd: 0.1, tokens: 38 });

    // Следующее сообщение, пока прошлый ход ещё в grace-буфере: расход остаётся.
    reg.start('c1', OPTIONS, {});
    expect(reg.spend()).toEqual({ costUsd: 0.1, tokens: 38 });
    created[1]!.emit(USAGE);
    created[1]!.emit(DONE(0.2));
    created[1]!.finish();
    await flush();
    expect(reg.spend().tokens).toBe(76);
    expect(reg.spend().costUsd).toBeCloseTo(0.3, 5);
  });
});

/**
 * Внешние события (запрос прав приходит не от CLI, а от MCP-сервера через HTTP)
 * и жизненный цикл буфера после завершения.
 */
describe('ChatRunRegistry — emitExternal и grace-период', () => {
  let fake: FakeRun;
  let registry: ChatRunRegistry;

  beforeEach(() => {
    fake = new FakeRun();
    registry = new ChatRunRegistry(() => fake);
  });

  const PERMISSION: ChatEvent = {
    kind: 'permission',
    toolName: 'Bash',
    input: { command: 'ls' },
    toolUseId: 'tu1',
  };

  it('emitExternal возвращает false, когда прогона нет', () => {
    expect(registry.emitExternal('нет', PERMISSION)).toBe(false);
  });

  it('emitExternal буферизует событие и доставляет живому слушателю с новым seq', () => {
    registry.start('c1', OPTIONS, {});
    fake.emit(SESSION); // seq 1

    const { events, sub } = collector();
    registry.attach('c1', 1, sub); // догон с 1 — буфер пуст, ждём живое

    expect(registry.emitExternal('c1', PERMISSION)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(2);
    expect(events[0]?.event.kind).toBe('permission');
  });

  it('завершённый прогон живёт в буфере, но убирается по истечении grace-периода', async () => {
    vi.useFakeTimers();
    try {
      registry.start('c1', OPTIONS, {});
      fake.emit(DONE_EVENT);
      fake.finish();
      // Дать сработать .then(() => finish()) — он и ставит cleanupTimer.
      await vi.advanceTimersByTimeAsync(0);

      // Сразу после завершения буфер ещё на месте — для догона хвоста после F5.
      expect(registry.has('c1')).toBe(true);
      expect(registry.isRunning('c1')).toBe(false);

      // Не дошли до конца grace — прогон всё ещё в буфере.
      await vi.advanceTimersByTimeAsync(59_000);
      expect(registry.has('c1')).toBe(true);

      // Grace истёк (60 c) — прогон убран, догонять больше нечего.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(registry.has('c1')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('active() отдаёт недавно завершённый УСПЕШНЫЙ прогон (догон хвоста после F5)', async () => {
    vi.useFakeTimers();
    try {
      registry.start('c1', OPTIONS, { projectPath: '/proj' });
      fake.emit(SESSION);
      fake.emit(DONE_EVENT);
      fake.finish();
      // Дать сработать .then(() => finish()) — он и ставит finishedAt + cleanupTimer.
      await vi.advanceTimersByTimeAsync(0);

      // Прогон уже не идёт, но лежит в grace-буфере — active() его отдаёт, чтобы
      // клиент дотянул терминальный хвост, если вкладка была закрыта в финиш.
      expect(registry.isRunning('c1')).toBe(false);
      // И называет его законченным: клиент заводит такой прогон сразу без
      // «работает» и дотягивает лишь хвост, а не печатает ответ заново.
      const [info] = registry.active();
      expect(info).toMatchObject({ chatId: 'c1', status: 'done' });
      expect(info?.finishedAt).toBeTypeOf('number');

      // За пределами grace прогон убран из буфера — возвращать больше нечего.
      await vi.advanceTimersByTimeAsync(61_000);
      expect(registry.has('c1')).toBe(false);
      expect(registry.active()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('active() НЕ воскрешает упавший прогон, даже пока он в grace-буфере', async () => {
    registry.start('c1', OPTIONS, {});
    fake.emit({ kind: 'error', message: 'сбой' });
    fake.finish();
    await flush();

    // В буфере ещё лежит (ошибку можно дочитать перечитыванием истории), но
    // повторно стримить её через active() не будем — иначе поток отдаст ошибку заново.
    expect(registry.has('c1')).toBe(true);
    expect(registry.active()).toHaveLength(0);
  });

  /**
   * Регрессия (двойной запуск): один разговор приходит в двух написаниях —
   * свежий чат под `new-…`, он же из списка в соседней вкладке — под sessionId.
   * Ключ строго по chatId их не сводил, и на один разговор поднималось два
   * процесса CLI: оба писали в один транскрипт и в одни файлы.
   */
  describe('одна беседа в двух написаниях ключа', () => {
    /** Реестр, считающий поднятые процессы. */
    const counting = (): { reg: ChatRunRegistry; created: FakeRun[] } => {
      const created: FakeRun[] = [];
      const reg = new ChatRunRegistry(() => {
        const run = new FakeRun();
        created.push(run);
        return run;
      });
      return { reg, created };
    };

    it('вторая вкладка под sessionId не поднимает второй процесс', () => {
      const { reg, created } = counting();
      expect(reg.start('new-1', OPTIONS, {})).toBe(true);
      created[0]?.emit(SESSION); // прогон получил sessionId 'sess-1'

      // Тот же разговор, открытый из списка: chatId = sessionId.
      expect(reg.isRunning('sess-1')).toBe(true);
      expect(reg.start('sess-1', OPTIONS, {})).toBe(false);
      expect(created).toHaveLength(1);
    });

    it('новый чат с известным sessionId в теле тоже не задваивает прогон', () => {
      const { reg, created } = counting();
      expect(reg.start('sess-1', OPTIONS, { sessionId: 'sess-1' })).toBe(true);

      // Другая вкладка начала «новый» чат, но продолжает ту же сессию.
      expect(reg.isRunning('new-2', 'sess-1')).toBe(true);
      expect(reg.start('new-2', OPTIONS, { sessionId: 'sess-1' })).toBe(false);
      expect(created).toHaveLength(1);
    });

    it('остановка и подключение по sessionId находят прогон под `new-…`', () => {
      const { reg, created } = counting();
      reg.start('new-1', OPTIONS, {});
      created[0]?.emit(SESSION);

      const { events, sub } = collector();
      expect(reg.attach('sess-1', 0, sub)).toBeTypeOf('function');
      expect(events).toHaveLength(1);

      expect(reg.stop('sess-1')).toBe(true);
      expect(created[0]?.stopped).toBe(true);
      expect(reg.has('new-1')).toBe(false);
    });
  });

  it('stopAll останавливает все прогоны и очищает реестр', () => {
    const created: FakeRun[] = [];
    const reg = new ChatRunRegistry(() => {
      const run = new FakeRun();
      created.push(run);
      return run;
    });
    reg.start('c1', OPTIONS, {});
    reg.start('c2', OPTIONS, {});

    reg.stopAll();

    expect(reg.has('c1')).toBe(false);
    expect(reg.has('c2')).toBe(false);
    expect(created.every((run) => run.stopped)).toBe(true);
  });
});

const DONE_EVENT: ChatEvent = { kind: 'done', costUsd: 0, durationMs: 1, sessionId: 'sess-1' };

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Журнал понижённых прогонов. До него отметка `lowered` умирала в маршруте:
 * сервер разворачивал по ней алиас, дописывал планку сдачи — и забывал, кто и
 * чем шёл. Реестр — единственное место, где виден ВЕСЬ прогон целиком, поэтому
 * запись собирается здесь, а куда её класть, знает bootstrap.
 */
describe('ChatRunRegistry — журнал понижённых прогонов', () => {
  const bash = (command: string): ChatEvent => ({
    kind: 'tool',
    name: 'Bash',
    input: { command },
    id: `t-${command}`,
  });

  it('записывает понижённый прогон с замеченными проверками', async () => {
    const fake = new FakeRun();
    const registry = new ChatRunRegistry(() => fake);
    const written: LoweredRunRecord[] = [];
    registry.setLoweredJournal((entry) => written.push(entry));

    registry.start('c1', OPTIONS, {
      projectPath: '/tmp/proj',
      lowered: { model: 'claude-sonnet-5', effort: 'high' },
    });
    fake.emit({ kind: 'session', sessionId: 'sess-9', model: 'claude-sonnet-5', tools: 1 });
    fake.emit(bash('pnpm test'));
    fake.emit(bash('ls src'));
    fake.emit(bash('npx tsc --noEmit'));
    fake.finish();
    await flush();

    expect(written).toHaveLength(1);
    expect(written[0]?.model).toBe('claude-sonnet-5');
    expect(written[0]?.effort).toBe('high');
    expect(written[0]?.sessionId).toBe('sess-9');
    expect(written[0]?.projectPath).toBe('/tmp/proj');
    expect(written[0]?.ok).toBe(true);
    // Записаны ТОЛЬКО похожие на проверки: `ls src` в список не попал.
    expect(written[0]?.checks).toEqual(['pnpm test', 'npx tsc --noEmit']);
  });

  /**
   * Класс работы и расход окна — то, из чего аналитика строит разрез «во что
   * обошёлся каждый класс». Без них журнал отвечает только «сколько раз
   * понизили», а спрашивают у него другое.
   */
  it('пишет класс работы и съеденное окно', async () => {
    const fake = new FakeRun();
    const registry = new ChatRunRegistry(() => fake);
    const written: LoweredRunRecord[] = [];
    registry.setLoweredJournal((entry) => written.push(entry));

    registry.start('c1', OPTIONS, {
      projectPath: '/tmp/proj',
      lowered: { model: 'claude-sonnet-5', effort: 'medium', kind: 'mechanical' },
    });
    fake.emit({
      kind: 'usage',
      input: 100,
      output: 20,
      cacheRead: 300,
      cacheCreation: 80,
      model: 'claude-sonnet-5',
      costUsd: 0,
    });
    fake.finish();
    await flush();

    expect(written[0]?.kind).toBe('mechanical');
    expect(written[0]?.tokens).toBe(500);
  });

  /** У ручного веера класса нет: ступень выбрал человек, рода работы никто не называл. */
  it('без класса поле в записи не появляется', async () => {
    const fake = new FakeRun();
    const registry = new ChatRunRegistry(() => fake);
    const written: LoweredRunRecord[] = [];
    registry.setLoweredJournal((entry) => written.push(entry));

    registry.start('c1', OPTIONS, { lowered: { model: 'claude-haiku-4-5', effort: '' } });
    fake.finish();
    await flush();

    expect(written[0]).not.toHaveProperty('kind');
  });

  it('прогон без проверок пишется с пустым списком, а не пропускается', async () => {
    const fake = new FakeRun();
    const registry = new ChatRunRegistry(() => fake);
    const written: LoweredRunRecord[] = [];
    registry.setLoweredJournal((entry) => written.push(entry));

    registry.start('c1', OPTIONS, { lowered: { model: 'claude-haiku-4-5', effort: '' } });
    fake.emit(bash('git status'));
    fake.finish();
    await flush();

    // Именно это и есть вопрос, ради которого журнал заведён: понижение было,
    // а прогона проверок панель не видела.
    expect(written).toHaveLength(1);
    expect(written[0]?.checks).toEqual([]);
  });

  it('прогон на потолке в журнал не попадает', async () => {
    const fake = new FakeRun();
    const registry = new ChatRunRegistry(() => fake);
    const written: LoweredRunRecord[] = [];
    registry.setLoweredJournal((entry) => written.push(entry));

    registry.start('c1', OPTIONS, { projectPath: '/tmp/proj' });
    fake.emit(bash('pnpm test'));
    fake.finish();
    await flush();

    expect(written).toEqual([]);
  });

  it('упавший прогон записан как упавший', async () => {
    const fake = new FakeRun();
    const registry = new ChatRunRegistry(() => fake);
    const written: LoweredRunRecord[] = [];
    registry.setLoweredJournal((entry) => written.push(entry));

    registry.start('c1', OPTIONS, { lowered: { model: 'claude-sonnet-5', effort: 'high' } });
    fake.emit({ kind: 'error', message: 'сломалось' });
    fake.finish();
    await flush();

    expect(written[0]?.ok).toBe(false);
  });

  it('падение журнала не мешает прогону закрыться', async () => {
    const fake = new FakeRun();
    const registry = new ChatRunRegistry(() => fake);
    registry.setLoweredJournal(() => {
      throw new Error('диск кончился');
    });

    registry.start('c1', OPTIONS, { lowered: { model: 'claude-sonnet-5', effort: 'high' } });
    const live = collector();
    registry.attach('c1', 0, live.sub);
    fake.finish();
    await flush();

    // Слушателя закрыли, прогон завершён — наблюдение не имеет права ломать работу.
    expect(live.state.closed).toBe(true);
    expect(registry.isRunning('c1')).toBe(false);
  });
});
