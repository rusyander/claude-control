import { describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BoardCard } from '@agentdeck/contracts/core/board';
import { INTAKE_SOURCES_MAX } from '@agentdeck/contracts/core/intake';
import { i18n } from '@shared/config/i18n';
import { BoardCardTile } from '../BoardCardTile';
import { RelatedHint } from './RelatedHint';
import { RelatedMerge } from './RelatedMerge';
import { canMerge, mergeMoveBody, mergeRefusalOf, reasonKeys } from './relatedMerge.lib';

/**
 * Подсказки «связано» и «Объединить» (B11, P186): значок на плитке — только подсказка, раздел в окне
 * записи — только при разрешённом ядром `merge` и найденных связях; тело хода несёт отмеченные записи.
 */

const entry: BoardCard = {
  kind: 'entry',
  id: 'e1',
  entryId: 'e1',
  column: 'inbox',
  title: 'PROJ-1 Login form',
  state: 'inbox',
  stop: 'plan',
  source: { kind: 'tracker', title: 'PROJ-1 Login form' },
  waiting: false,
  questions: 0,
  takeover: null,
  moves: ['queue', 'rejected', 'merge'],
  createdAt: 1_700_000_000_000,
  related: [
    { entryId: 'e2', title: 'PROJ-2 Login errors', reasons: ['path', 'epic'] },
    { entryId: 'e3', title: 'PROJ-3 Session expiry', reasons: ['link'] },
  ],
};

async function render(node: ReactNode, lang = 'ru'): Promise<string> {
  await i18n.changeLanguage(lang);
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );
}

describe('core board related hints', () => {
  it('the tile shows «связано: N» with every related title and reason in its hint', async () => {
    const html = await render(<BoardCardTile card={entry} onOpen={() => {}} />);
    expect(html).toContain('data-board-related="2"');
    expect(html).toContain('связано: 2');
    expect(html).toContain(
      'PROJ-2 Login errors (общий эпик или родитель, общий путь в обоих тикетах)',
    );
    expect(html).toContain('PROJ-3 Session expiry (связь задач)');
    // Плитка — кнопка: внутри значка нет второго интерактивного элемента.
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).not.toContain('<input');
  });

  it('a card without related entries shows no hint', async () => {
    const html = await render(<RelatedHint card={{ related: [] }} />);
    expect(html).toBe('');
    expect(await render(<RelatedHint card={{}} />)).toBe('');
  });

  it('the card window lists related entries checked by default with a merge button counting them', async () => {
    const html = await render(<RelatedMerge card={entry} />);
    expect(html).toContain('data-related-merge');
    expect(html).toContain('data-related-item="e2"');
    expect(html).toContain('data-related-item="e3"');
    expect(html.match(/checked=""/g)).toHaveLength(2);
    expect(html).toContain('Объединить в эту (2)');
    expect(html).toContain('Само ничего не объединяется.');
  });

  it('the English window says the same', async () => {
    const html = await render(<RelatedMerge card={entry} />, 'en');
    expect(html).toContain('Merge into this card (2)');
    expect(html).toContain('same epic or parent, same path in both tickets');
  });

  it('more relations than one task takes: only the first fit are checked, the rest locked, the reason shown', async () => {
    // Ядро берёт в задачу не больше INTAKE_SOURCES_MAX снимков: эта запись и ещё MAX − 1.
    const cap = INTAKE_SOURCES_MAX - 1;
    const many: BoardCard = {
      ...entry,
      related: Array.from({ length: cap + 3 }, (_, i) => ({
        entryId: `r${i}`,
        title: `PROJ-${100 + i} Related`,
        reasons: ['epic' as const],
      })),
    };
    const html = await render(<RelatedMerge card={many} />);
    expect(html.match(/checked=""/g)).toHaveLength(cap);
    expect(html.match(/<input[^>]*disabled=""/g)).toHaveLength(3);
    expect(html).toContain(`Объединить в эту (${cap})`);
    expect(html).toContain('data-related-merge-cap');
    expect(html).toContain(`не больше ${INTAKE_SOURCES_MAX} тикетов`);
    // Связей в пределе — ни замков, ни строки предела.
    const few = await render(<RelatedMerge card={entry} />);
    expect(few).not.toContain('data-related-merge-cap');
    expect(few).not.toContain('disabled=""');
  });

  it('no merge section when the core did not allow merge or found no relation', async () => {
    expect(await render(<RelatedMerge card={{ ...entry, moves: ['queue'] }} />)).toBe('');
    expect(await render(<RelatedMerge card={{ ...entry, related: [] }} />)).toBe('');
    expect(await render(<RelatedMerge card={{ ...entry, kind: 'task' }} />)).toBe('');
  });
});

describe('core board merge move', () => {
  it('canMerge needs an entry, the core-allowed merge move and at least one relation', () => {
    expect(canMerge(entry)).toBe(true);
    expect(canMerge({ ...entry, moves: ['queue'] })).toBe(false);
    expect(canMerge({ ...entry, related: undefined })).toBe(false);
    expect(canMerge({ ...entry, kind: 'task' })).toBe(false);
  });

  it('the move body carries the target, the folded entries, the retry key and the page proof', () => {
    const body = mergeMoveBody('e1', ['e2', 'e3'], { nonce: 'n', page: 'p' }, 'cmd-1');
    expect(body).toEqual({
      cmdId: 'cmd-1',
      entryId: 'e1',
      to: 'merge',
      entryIds: ['e2', 'e3'],
      proof: { nonce: 'n', page: 'p' },
    });
  });

  it('reasons show in contract order without repeats', () => {
    expect(reasonKeys(['path', 'epic', 'path'])).toEqual(['epic', 'path']);
  });

  // Проза ядра — та, что пишет `moves.ts` applyMerge: на экран идёт строка словаря, проза — подсказкой.
  const refusal = (reason: string, status = 409) => ({
    response: {
      status,
      data: { error: 'Ход доски не разрешён', code: 'move-not-allowed', reason },
    },
  });

  it('a merge refusal maps the core English prose to a dictionary line and keeps the prose raw', async () => {
    const queued = mergeRefusalOf(
      refusal('entry 0190-e2 (PROJ-11) is queued: only inbox entries merge'),
    );
    expect(queued).toEqual({
      code: 'move-not-allowed',
      key: 'notInbox',
      values: { ticket: 'PROJ-11' },
      raw: 'entry 0190-e2 (PROJ-11) is queued: only inbox entries merge',
    });
    const table: [string, string, Record<string, string>][] = [
      [
        'entry e2 (PROJ-2) starts from its MR link; an MR entry does not merge',
        'mrEntry',
        { ticket: 'PROJ-2' },
      ],
      [
        'entry e2 (manual) carries no ticket snapshot; only ticket entries merge',
        'noTicket',
        { ticket: 'manual' },
      ],
      [
        'merge would carry 17 ticket snapshots; one task takes at most 16',
        'tooManyTickets',
        { count: '17', max: '16' },
      ],
      [
        'merge would fold 201 sources; an entry keeps at most 200',
        'tooManySources',
        { count: '201', max: '200' },
      ],
      ['an entry does not merge into itself', 'self', {}],
      ['merge names no entries to fold', 'empty', {}],
      ['move merge is not allowed from queued', 'notAllowed', {}],
      ['no board entry e9', 'gone', {}],
      ['something new', 'generic', {}],
    ];
    for (const [raw, key, values] of table) {
      expect(mergeRefusalOf(refusal(raw)), raw).toMatchObject({ key, values, raw });
    }
    expect(mergeRefusalOf(new Error('Network Error')).key).toBe('noAnswer');
    // Каждый ключ отказа есть в обоих словарях: строка не уходит на экран сырым ключом.
    for (const lang of ['ru', 'en']) {
      await i18n.changeLanguage(lang);
      for (const key of [...table.map(([, k]) => k), 'notInbox', 'noAnswer']) {
        const text = i18n.t(`coreBoard.related.refusals.${key}`, {
          ticket: 'PROJ-11',
          count: 1,
          max: 2,
        });
        expect(text, `${lang}:${key}`).not.toContain('coreBoard.related');
      }
    }
    await i18n.changeLanguage('ru');
    expect(i18n.t('coreBoard.related.refusals.notInbox', queued.values)).toBe(
      'PROJ-11 уже не во «Входящих» — объединяются только записи «Входящих»',
    );
  });
});
