import { describe, it, expect } from 'vitest';
import {
  mergeSplitTickets,
  scanSplitHumanSteps,
  scanSplitTickets,
  SPLIT_HUMAN_TAG,
  SPLIT_TICKET_TAG,
  SPLIT_TICKETS_MAX,
  withoutSplitTickets,
} from '@agentdeck/contracts/split-tickets';
import { splitTicketPreamble } from '@agentdeck/contracts/task-split';
import { PendingAsks } from './pending-asks.ts';
import type { RunFinished } from './ChatRunRegistry.ts';

/**
 * Разбор блока тикета (95b) — то, что агент может написать криво: поле на
 * несколько строк, пустое название, простыня вместо описания, двадцать первый
 * тикет. Запись живёт в `state.json`, и болтливая группа не должна её раздуть.
 */

const block = (...lines: string[]) =>
  [`<${SPLIT_TICKET_TAG}>`, ...lines, `</${SPLIT_TICKET_TAG}>`].join('\n');

describe('scanSplitTickets', () => {
  it('значение продолжается следующими строками и склеивается в одну', () => {
    const [ticket] = scanSplitTickets(
      block(
        'title: Падает экспорт',
        'where: export.ts:42',
        'why: пустой файл',
        'при пустом фильтре',
      ),
    );

    expect(ticket).toEqual({
      title: 'Падает экспорт',
      where: 'export.ts:42',
      why: 'пустой файл при пустом фильтре',
    });
  });

  it('без названия или без «где» и «почему» — не тикет', () => {
    expect(scanSplitTickets(block('where: a.ts:1', 'why: плохо'))).toEqual([]);
    expect(scanSplitTickets(block('title: Что-то не так'))).toEqual([]);
  });

  it('длинные поля обрезаются по потолку', () => {
    const [ticket] = scanSplitTickets(
      block(`title: ${'т'.repeat(500)}`, 'where: a.ts:1', `why: ${'п'.repeat(5000)}`),
    );

    expect(ticket?.title).toHaveLength(200);
    expect(ticket?.title.endsWith('…')).toBe(true);
    expect(ticket?.why).toHaveLength(1500);
  });

  it('блок вынимается из текста хода, остальное остаётся', () => {
    const text = `Отчёт.\n\n${block('title: X', 'where: a.ts:1')}\n\nКонец.`;

    expect(withoutSplitTickets(text)).toBe('Отчёт.\n\n\n\nКонец.');
  });

  it('шаг человеку — свой список: поля тикета и шага не смешиваются', () => {
    const human = [
      `<${SPLIT_HUMAN_TAG}>`,
      'action: выставить зависимость MR',
      '  !808 от !789',
      'where: https://git.example/p/-/merge_requests/808',
      `</${SPLIT_HUMAN_TAG}>`,
    ].join('\n');
    const text = `Отчёт.\n\n${block('title: X', 'where: a.ts:1')}\n\n${human}`;

    expect(scanSplitTickets(text)).toEqual([{ title: 'X', where: 'a.ts:1', why: '' }]);
    expect(scanSplitHumanSteps(text)).toEqual([
      {
        action: 'выставить зависимость MR !808 от !789',
        where: 'https://git.example/p/-/merge_requests/808',
        why: '',
      },
    ]);
    expect(withoutSplitTickets(text)).toBe('Отчёт.');
  });

  it('задание группы учит обоим блокам ровно в том формате, который разбирает сервер', () => {
    const preamble = splitTicketPreamble();

    expect(scanSplitTickets(preamble)).toHaveLength(1);
    expect(scanSplitHumanSteps(preamble)).toEqual([
      expect.objectContaining({ action: 'что сделать' }),
    ]);
  });

  it('шаг без самого шага — не шаг; недописанный прячется у идущего ответа', () => {
    const empty = `<${SPLIT_HUMAN_TAG}>\nwhere: x\n</${SPLIT_HUMAN_TAG}>`;
    expect(scanSplitHumanSteps(empty)).toEqual([]);
    const open = `Отчёт.\n\n<${SPLIT_HUMAN_TAG}>\naction: Y`;
    expect(withoutSplitTickets(open, { streaming: true })).toBe('Отчёт.');
  });

  it('недописанный блок прячется с хвостом только у идущего ответа', () => {
    const text = `Отчёт.\n\n${block('title: X', 'where: a.ts:1')}\n\nЕщё.\n\n<${SPLIT_TICKET_TAG}>\ntitle: Y`;

    expect(withoutSplitTickets(text, { streaming: true })).toBe('Отчёт.\n\n\n\nЕщё.');
    expect(withoutSplitTickets(text)).toContain('title: Y');
  });

  /**
   * Итоговое ревью 25.09 (m10): сообщение, описывающее формат блока примером в
   * блоке кода, теряло пример в ленте, и сервер записывал из него тикет-призрак;
   * текст без блоков всё равно обрезался по краям.
   */
  it('пример блока внутри ``` — не тикет и остаётся в тексте', () => {
    const example = ['```', block('title: Пример', 'where: a.ts:1'), '```'].join('\n');
    const text = `Формат такой:\n\n${example}`;

    expect(scanSplitTickets(text)).toEqual([]);
    expect(withoutSplitTickets(text)).toBe(text);
    expect(withoutSplitTickets(`${text}\n\n<${SPLIT_TICKET_TAG}>`, { streaming: true })).toBe(
      `${text}\n\n`.trim(),
    );
  });

  it('текст без блоков возвращается как есть — края не обрезаются', () => {
    expect(withoutSplitTickets('  отступ\n')).toBe('  отступ\n');
  });
});

describe('mergeSplitTickets', () => {
  it('сверх потолка новые не принимаются', () => {
    const found = Array.from({ length: SPLIT_TICKETS_MAX + 5 }, (_, i) => ({
      title: `Дефект ${i}`,
      where: `f${i}.ts:1`,
      why: '',
    }));

    expect(mergeSplitTickets(undefined, found, 'at')).toHaveLength(SPLIT_TICKETS_MAX);
  });
});

/**
 * Карточка «ждёт вас» в дереве пишется по сырому тексту хода (`PendingAsks`,
 * его зовёт рантайм на каждом конце прогона). Строка «why: …?» внутри блока —
 * описание чужого дефекта, а не вопрос группы человеку.
 */
describe('вопрос текстом и блок тикета', () => {
  const finished = (text: string): RunFinished => ({
    chatId: 'new-g1',
    sessionId: 'sess-g1',
    text,
    ok: true,
    startedAt: 0,
    options: { prompt: '', cwd: '/copy' },
    contextTokens: 0,
  });
  const asksAfter = (text: string) => {
    const store = new PendingAsks({ isTreeChat: () => true });
    store.finished(finished(text));
    return store.of(['sess-g1'], () => false);
  };

  it('«?» внутри блока карточки вопроса не заводит', () => {
    const text = `Готово.\n\n${block('title: Падает экспорт', 'where: a.ts:1', 'why: почему пустой файл?')}`;

    expect(asksAfter(text)).toEqual([]);
    const human = `<${SPLIT_HUMAN_TAG}>\naction: выставить зависимость MR\nwhy: можно ли без неё?\n</${SPLIT_HUMAN_TAG}>`;
    expect(asksAfter(`Готово.\n\n${human}`)).toEqual([]);
  });

  it('контроль: тот же «?» последней строкой ответа — вопрос', () => {
    expect(asksAfter('Готово.\n\nпочему пустой файл?')).toEqual([
      expect.objectContaining({ kind: 'text' }),
    ]);
  });
});
