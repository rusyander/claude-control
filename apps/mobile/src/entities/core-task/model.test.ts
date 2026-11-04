import { describe, expect, it } from 'vitest';
import { UUIDV7_PATTERN } from '@agentdeck/contracts/core/ids';
import {
  askCardOf,
  commandsForChoice,
  coreAskTarget,
  openAskCards,
  takeSseFrames,
  uuidv7,
  type CoreAskCard,
} from './model';

/**
 * Задачи ядра на телефоне — чистая часть: поток событий → карточки вопросов, выбор → команды
 * ядра (как у панели), push о вопросе ядра → экран задачи, `cmdId` — uuidv7, который примет ядро.
 */

const TASK = '019a0000-0000-7000-8000-000000000001';
const ASK = '019a0000-0000-7000-8000-0000000000a1';
const SPLIT = '019a0000-0000-7000-8000-0000000000b1';

const asked = (seq: number, data: Record<string, unknown>) =>
  `id: ${seq}\nevent: human.asked\ndata: ${JSON.stringify({ seq, kind: 'human.asked', data })}\n\n`;

const launchAsk: CoreAskCard = {
  askId: ASK,
  point: 10,
  source: 'launch',
  question: 'Запустить?',
  options: ['approve-split', 'edit-split', 'cancel'],
  defaultAction: 'approve-split',
  splitId: SPLIT,
};

describe('core task model (mobile)', () => {
  it('SSE text → frames across chunk borders; comments skipped; human.asked → ask card with splitId', () => {
    const whole =
      ': open\n\n' +
      asked(3, {
        askId: ASK,
        point: 10,
        source: 'launch',
        dedupe: `split:${SPLIT}`,
        question: 'Запустить?',
        options: ['approve-split', 'cancel'],
        defaultAction: 'approve-split',
      }) +
      'id: 4\nevent: step.started\ndata: {"seq":4,"kind":"step.started","data":{}}\n\n: ping\n\nid: 5\nda';
    const cut = whole.length - 40;
    const first = takeSseFrames(whole.slice(0, cut));
    const second = takeSseFrames(first.rest + whole.slice(cut));
    const frames = [...first.frames, ...second.frames];
    expect(frames.map((frame) => frame.id)).toEqual(['3', '4']);
    expect(second.rest).toBe('id: 5\nda');
    expect(frames.map(askCardOf)).toEqual([
      {
        askId: ASK,
        point: 10,
        source: 'launch',
        question: 'Запустить?',
        options: ['approve-split', 'cancel'],
        defaultAction: 'approve-split',
        splitId: SPLIT,
      },
      null,
    ]);
    expect(askCardOf({ id: '1', event: 'human.asked', data: 'not json' })).toBeNull();
  });

  it('open asks only, details from the journal, a missing line still shows the ask', () => {
    const other = '019a0000-0000-7000-8000-0000000000a2';
    const cards = openAskCards(
      [
        { askId: ASK, state: 'open', point: 10, source: 'launch' },
        { askId: other, state: 'open', point: 3, source: 'ask_human' },
        {
          askId: '019a0000-0000-7000-8000-0000000000a3',
          state: 'answered',
          point: 3,
          source: 'ask_human',
        },
      ],
      new Map([[ASK, launchAsk]]),
    );
    expect(cards.map((card) => [card.askId, card.question])).toEqual([
      [ASK, 'Запустить?'],
      [other, ''],
    ]);
  });

  it('choice → core commands: answer by text/option, launch approve-split and cancel, edit-split → panel', () => {
    expect(commandsForChoice(TASK, launchAsk, { type: 'text', text: '  да  ' })).toEqual([
      { kind: 'answer', target: { taskId: TASK }, fields: { askId: ASK, answer: 'да' } },
    ]);
    expect(commandsForChoice(TASK, launchAsk, { type: 'text', text: '  ' })).toBeNull();
    expect(
      commandsForChoice(TASK, launchAsk, {
        type: 'option',
        option: 'approve-split',
        cancelReason: 'r',
      }),
    ).toEqual([{ kind: 'approve-split', target: { taskId: TASK }, fields: { splitId: SPLIT } }]);
    expect(
      commandsForChoice(TASK, launchAsk, { type: 'option', option: 'cancel', cancelReason: 'r' }),
    ).toEqual([{ kind: 'cancel', target: { taskId: TASK }, fields: { reason: 'r' } }]);
    expect(
      commandsForChoice(TASK, launchAsk, {
        type: 'option',
        option: 'edit-split',
        cancelReason: 'r',
      }),
    ).toBeNull();
    const plain = { ...launchAsk, source: 'ask_human' as const, splitId: null };
    expect(
      commandsForChoice(TASK, plain, {
        type: 'option',
        option: 'approve-split',
        cancelReason: 'r',
      }),
    ).toEqual([
      { kind: 'answer', target: { taskId: TASK }, fields: { askId: ASK, answer: 'approve-split' } },
    ]);
  });

  it('push data of kind core-ask → task screen target; other pushes → none', () => {
    expect(coreAskTarget({ kind: 'core-ask', taskId: TASK, askId: ASK, machineId: 'm-1' })).toEqual(
      { taskId: TASK, askId: ASK, machineId: 'm-1' },
    );
    expect(coreAskTarget({ kind: 'done', chatId: 'c1' })).toBeUndefined();
    expect(coreAskTarget({ kind: 'core-ask', taskId: ' ' })).toBeUndefined();
    expect(coreAskTarget(null)).toBeUndefined();
  });

  it('cmdId is a uuidv7 the core accepts, time-ordered', () => {
    const bytes = new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255, 255, 255]);
    const id = uuidv7(bytes, 1_762_000_000_000);
    expect(id).toMatch(UUIDV7_PATTERN);
    expect(uuidv7(new Uint8Array(10), 1)).toMatch(UUIDV7_PATTERN);
    expect(uuidv7(new Uint8Array(10), 2) > uuidv7(new Uint8Array(10), 1)).toBe(true);
  });
});
