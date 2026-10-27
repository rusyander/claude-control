import { describe, expect, it } from 'vitest';
import { localizeText } from '../../../lib/server-texts/server-texts.ts';
import { mrDescriptionGap } from './delivery-facts.ts';
import { unhomedItems } from './unhomed.ts';

/**
 * g8 26.10 (F11): «Не исправлено: комментарий в UsagePage/index.tsx:47-48 … делается
 * отдельно.» — без ключа задачи, которая это возьмёт. Сверка доставки называет такую строку.
 */

const MR = 'https://git.example.com/team/app/-/merge_requests/7';

describe('описание MR: «отдельно» без ключа задачи', () => {
  it('оборот «на потом» без ключа — пункт без дома; с ключом — нет', () => {
    expect(
      unhomedItems(
        '## Остаётся открытым\n- Не исправлено: комментарий в UsagePage/index.tsx:47-48 — делается отдельно.\n',
      ),
    ).toEqual(['Не исправлено: комментарий в UsagePage/index.tsx:47-48 — делается отдельно.']);
    expect(unhomedItems('- комментарий в UsagePage — делается отдельно, PROJ-2023.')).toEqual([]);
    expect(unhomedItems('- Wording of the badge will be fixed separately.')).toHaveLength(1);
    expect(unhomedItems('- Moved to a follow-up ticket.')).toHaveLength(1);
    expect(unhomedItems('- Moved to a follow-up ticket ABC-77.')).toEqual([]);
    expect(unhomedItems('- Lives in a follow-up task.')).toHaveLength(1);
    expect(unhomedItems('- Вынесено отдельной задачей PROJ-9.')).toEqual([]);
    expect(unhomedItems('- Оформить отдельной задачей.')).toHaveLength(1);
  });

  it('просто «отдельно» — не пункт на потом', () => {
    expect(
      unhomedItems('Каждая локаль проверена отдельно.\nEach page was checked separately.'),
    ).toEqual([]);
  });

  it('сверка описания держит строку пробела с самим пунктом', async () => {
    const gap = await mrDescriptionGap(MR, async () => ({
      description: 'Что и зачем.\n\n## Открыто\n- Подпись бейджа — сделаем отдельно.\n',
    }));
    const lines = (gap.missing ?? []).map((line) => localizeText(line, 'en'));
    expect(lines).toEqual([
      `MR ${MR} description: left «separately» with no key of the task that takes it (Подпись бейджа — сделаем отдельно.) — add the task key (PROJ-123), fix it in this branch, or ask the human`,
    ]);
    expect(
      await mrDescriptionGap(MR, async () => ({
        description: 'Что и зачем.\n- Подпись бейджа — сделаем отдельно в PROJ-12.\n',
      })),
    ).toEqual({});
  });
});
