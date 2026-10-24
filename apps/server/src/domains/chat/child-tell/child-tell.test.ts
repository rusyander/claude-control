import { describe, expect, it } from 'vitest';
import type { SplitPlanView } from '@agentdeck/contracts/chat-handoff';
import { ChildTells, parseTells, tellPrompt, type TellStart } from './child-tell.ts';
import type { ChatEvent } from '../ChatRunner/ChatRunner.ts';

const SPLIT: SplitPlanView = {
  parentChatId: 'parent',
  order: [0, 1, 2],
  groups: [
    {
      index: 0,
      title: 'Шапка',
      branch: 'f/h',
      after: [],
      status: 'done',
      chatId: 'new-1',
      path: '/c/h',
    },
    {
      index: 1,
      title: 'Тесты',
      branch: 'f/t',
      after: [],
      status: 'started',
      chatId: 'new-2',
      path: '/c/t',
    },
    { index: 2, title: 'Доки', branch: 'f/d', after: [1], status: 'waiting' },
  ],
};

/** Ключи разговоров групп: временный и настоящий, как их пишет перенос связи. */
const ALIASES: Record<string, string[]> = {
  'new-1': ['new-1', 'sess-1'],
  'new-2': ['new-2', 'sess-2'],
};

function setup(busy: Set<string> = new Set()) {
  const starts: Parameters<TellStart>[0][] = [];
  const notices: { keys: readonly string[]; event: ChatEvent }[] = [];
  const deferred: (() => void)[] = [];
  const tells = new ChildTells({
    split: (keys) => (keys.includes('parent') ? SPLIT : undefined),
    aliasesOf: (chatId) => ALIASES[chatId] ?? [chatId],
    settingsOf: (chatId) => (chatId === 'new-1' ? { model: 'claude-sonnet-5' } : {}),
    start: (input) => {
      if (busy.has(input.chatId)) return { started: false, busy: true };
      starts.push(input);
      return { started: true };
    },
    notify: (keys, event) => notices.push({ keys, event }),
    log: () => undefined,
    defer: (run) => deferred.push(run),
  });
  return { tells, starts, notices, deferred, busy };
}

const reply = (...blocks: [number, string][]): string =>
  [
    'Сделаю так.',
    ...blocks.map(([to, text]) => `\`\`\`agentdeck:tell ${to}\n${text}\n\`\`\``),
  ].join('\n\n');

describe('parseTells (Д7)', () => {
  it('блоки с номером группы и текстом; пустые и без номера — мимо', () => {
    const text = [
      reply([1, 'Шапку делай липкой.'], [2, 'Тесты на мобильный тоже.']),
      '```agentdeck:tell 0\nнет такой\n```',
      '```agentdeck:tell 3\n\n```',
      '```agentdeck:tell\nбез номера\n```',
    ].join('\n');

    expect(parseTells(text)).toEqual([
      { to: 1, text: 'Шапку делай липкой.' },
      { to: 2, text: 'Тесты на мобильный тоже.' },
    ]);
  });
});

describe('ChildTells (Д7)', () => {
  it('свободной группе — продолжением ЕЁ сессии, в её копии и её моделью', () => {
    const { tells, starts, notices } = setup();

    tells.parentFinished(['parent'], reply([1, 'Шапку делай липкой.']));

    expect(starts).toEqual([
      {
        chatId: 'sess-1',
        prompt: tellPrompt('Шапку делай липкой.'),
        cwd: '/c/h',
        model: 'claude-sonnet-5',
        stage: 'tell',
        fromAliases: ['new-1', 'sess-1'],
        resume: { sessionId: 'sess-1' },
      },
    ]);
    expect(notices[0]?.event).toMatchObject({
      kind: 'notice',
      code: 'childTold',
      textCode: 'child-tell-notice',
      textParams: { sent: '«Шапка»', queued: '—', refused: '—' },
    });
  });

  it('слово панели доносит до запуска вводную и ветку, от которой отведена копия', () => {
    const { tells, starts } = setup();

    tells.send({
      chatId: 'sess-1',
      prompt: 'Продолжай.',
      cwd: '/c/h',
      title: 'Шапка',
      cold: 'Branch split/next.',
      base: 'split/pred',
    });

    expect(starts[0]).toMatchObject({ cold: 'Branch split/next.', base: 'split/pred' });
  });

  it('занятой группе — в очередь, и доставка после конца её хода', () => {
    const { tells, starts, notices, deferred, busy } = setup(new Set(['sess-2']));

    tells.parentFinished(['parent'], reply([2, 'Тесты на мобильный тоже.']));
    expect(starts).toEqual([]);
    expect(notices[0]?.event).toMatchObject({ textParams: { sent: '—', queued: '«Тесты»' } });

    // Ход чужого разговора очередь не трогает.
    tells.childFinished(['sess-1']);
    expect(deferred).toHaveLength(0);

    busy.clear();
    tells.childFinished(['new-2', 'sess-2']);
    // Не изнутри завершения хода: новый старт заменил бы закрывающийся прогон.
    expect(starts).toEqual([]);
    deferred.forEach((run) => run());
    expect(starts.map((start) => [start.chatId, start.prompt])).toEqual([
      ['sess-2', tellPrompt('Тесты на мобильный тоже.')],
    ]);

    // Доставленное второй раз не уезжает.
    tells.childFinished(['sess-2']);
    expect(deferred).toHaveLength(1);
  });

  /**
   * D-L02: продолжение D-n помечалось сделанным уже на «в очереди», а очередь
   * живёт в памяти — перезапуск панели до конца хода терял слово навсегда.
   * Теперь о доставке говорит сама доставка.
   */
  it('«дошло» зовётся в момент доставки, а не постановки в очередь', () => {
    const { tells, deferred, busy } = setup(new Set(['sess-2']));
    const sent: string[] = [];
    const message = {
      chatId: 'new-2',
      prompt: 'Человек разрешил D-5.',
      cwd: '/c/t',
      title: 'Тесты',
      onSent: () => sent.push('D-5'),
    };

    expect(tells.send(message)).toBe('queued');
    expect(sent).toEqual([]);

    busy.clear();
    tells.childFinished(['sess-2']);
    deferred.forEach((run) => run());
    expect(sent).toEqual(['D-5']);
  });

  it('слово, которое доставлено сразу, помечается тут же', () => {
    const { tells } = setup();
    const sent: string[] = [];
    expect(
      tells.send({
        chatId: 'new-1',
        prompt: 'Человек разрешил D-6.',
        cwd: '/c/h',
        title: 'Шапка',
        onSent: () => sent.push('D-6'),
      }),
    ).toBe('sent');
    expect(sent).toEqual(['D-6']);
  });

  /**
   * RF-DL-01: слово об исходах D-n, пролежавшее в очереди до конца хода, —
   * текст на миг доставки; сказать уже нечего — старта нет и «дошло» не зовётся.
   */
  it('текст слова складывается в миг доставки; нечего сказать — старта нет', () => {
    const { tells, starts, deferred, busy } = setup(new Set(['sess-2']));
    const sent: string[] = [];
    let now = 'Человек разрешил D-7.';
    let left: string | undefined = 'x';
    const message = {
      chatId: 'new-2',
      prompt: 'устаревший текст',
      cwd: '/c/t',
      title: 'Тесты',
      onSent: () => sent.push('told'),
      render: () => (left === undefined ? undefined : now),
    };
    expect(tells.send(message)).toBe('queued');
    now = 'Человек разрешил D-7 и отказал D-8.';
    busy.clear();
    tells.childFinished(['sess-2']);
    deferred.forEach((run) => run());
    expect(starts.map((start) => start.prompt)).toEqual(['Человек разрешил D-7 и отказал D-8.']);
    expect(sent).toEqual(['told']);

    left = undefined;
    expect(tells.send({ ...message, chatId: 'new-1', cwd: '/c/h' })).toBe('sent');
    expect(starts).toHaveLength(1);
    expect(sent).toEqual(['told']);
  });

  it('группе без чата и несуществующей группе — отказ в заметке, без запуска', () => {
    const { tells, starts, notices } = setup();

    tells.parentFinished(['parent'], reply([3, 'Доки тоже.'], [9, 'Кому?']));

    expect(starts).toEqual([]);
    expect(notices[0]?.event).toMatchObject({ textParams: { sent: '—', refused: '«Доки», #9' } });
  });

  it('разговор без разделения и ответ без блоков — ничего', () => {
    const { tells, starts, notices } = setup();

    tells.parentFinished(['solo'], reply([1, 'Шапку делай липкой.']));
    tells.parentFinished(['parent'], 'Просто ответ.');

    expect(starts).toEqual([]);
    expect(notices).toEqual([]);
  });
});
