import { describe, expect, it } from 'vitest';
import { i18n } from '@shared/config/i18n';
import { moveRefusalOf } from './cardMoves.lib';

/**
 * Отказ хода карточки (P152): проза `moves.ts` applyMove английская по контракту — на экран идёт
 * строка словаря `coreBoard.moves.refusals.*`, проза остаётся в `raw` (подсказка строки).
 */

const refusal = (reason: string) => ({
  response: {
    status: 409,
    data: { error: 'Ход доски не разрешён', code: 'move-not-allowed', allowed: [], reason },
  },
});

describe('core card move refusal', () => {
  it('maps the core English prose to a dictionary key and keeps the prose raw', async () => {
    expect(moveRefusalOf(refusal('move rejected is not allowed from rejected'))).toEqual({
      code: 'move-not-allowed',
      key: 'notAllowed',
      values: { move: 'rejected', state: 'rejected' },
      raw: 'move rejected is not allowed from rejected',
    });
    const table: [string, string][] = [
      [
        'a started task moves by its journal; use the task commands (take-over, rework, set-stop, cancel)',
        'startedTask',
      ],
      [
        'a task card has no board moves; use the task commands (take-over, rework, set-stop, cancel)',
        'taskCard',
      ],
      ['"before" orders only the queue or the inbox, not rejected', 'beforeOnly'],
      ['entry e9 is not in the queued column', 'anchorGone'],
      ['no board entry e9', 'gone'],
      ['something new', 'generic'],
    ];
    for (const [raw, key] of table) {
      expect(moveRefusalOf(refusal(raw)), raw).toMatchObject({ key, raw });
    }
    expect(moveRefusalOf(new Error('Network Error')).key).toBe('noAnswer');
    // Каждый ключ есть в обоих словарях: строка не уходит на экран сырым ключом.
    for (const lang of ['ru', 'en']) {
      await i18n.changeLanguage(lang);
      for (const key of [...table.map(([, k]) => k), 'notAllowed', 'noAnswer']) {
        const text = i18n.t(`coreBoard.moves.refusals.${key}`, { move: 'm', state: 's' });
        expect(text, `${lang}:${key}`).not.toContain('coreBoard.moves');
      }
    }
    await i18n.changeLanguage('ru');
    expect(
      i18n.t('coreBoard.moves.refusals.notAllowed', {
        move: i18n.t('coreBoard.moves.rejected'),
        state: i18n.t('coreBoard.entryState.rejected'),
      }),
    ).toBe('карточка уже «отклонена» — ход «Отклонить» отсюда не делается');
  });
});
