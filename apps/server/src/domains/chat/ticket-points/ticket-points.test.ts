import type { SieveReportRow } from '@agentdeck/contracts/sieves';
import { describe, expect, it } from 'vitest';
import { matchText } from '../../../lib/server-texts/server-texts.ts';
import {
  misnumberedPointGaps,
  ticketPointGaps,
  ticketPoints,
  unmappedPoints,
} from './ticket-points.ts';

/**
 * Пункты тикетов против строк следа задач (аудит g5 27.10, H1). Владелец просил в комментариях
 * обеих задач PDF «Отчёт для дизайна»; группа сдала 7 строк на 37 пунктов, проверка доставки
 * судила только сданные строки, и перепроверка о PDF не сказала ни слова. Судья чистый:
 * файл задач и строки `task-N` — входом.
 */

const TICKETS = [
  '# Tracker tickets of this group',
  '',
  '## PROJ-1 — Отчёт по журналу',
  'Status: В работе · type: Story',
  '',
  'h3. Что сейчас',
  '* Журнал открывается без фильтров вообще',
  'h3. Что сделать',
  '* Фильтр журнала принимает диапазон дат',
  '# Кнопка «Сохранить» недоступна без прав',
  '- Ок',
  '1. Экспорт журнала в CSV с фильтром',
  '',
  '### Attachments',
  '- design report v2.pdf (120 KB)',
  '',
  '### Comments',
  '**Владелец** · 2026-10-26 18:00',
  '* Нужен PDF «Отчёт для дизайна» к обеим задачам',
  '',
  '## PROJ-2 — Экспорт',
  'Status: Открыта · type: Story',
  '',
  '* Фильтр журнала принимает диапазон дат',
  '+ Экспорт журнала в CSV с фильтром',
  '',
  '## PROJ-3 — Старая',
  'Not updated in the tracker since the last delivery (2026-10-26T15:00:00.000Z)',
  '* Этот пункт задачи не судится вовсе',
  '',
].join('\n');

const row = (id: string, evidence: string, status: SieveReportRow['status'] = 'pass') => ({
  id,
  status,
  evidence,
});

const codes = (lines: readonly string[]) => lines.map((line) => matchText(line)?.messageCode);

describe('ticket-points: пункты тикетов из файла задач', () => {
  it('строки списков всех видов, без разделов состояния, вложений, коротких подписей и указателей', () => {
    expect(ticketPoints(TICKETS).map((point) => `${point.key}: ${point.text}`)).toEqual([
      'PROJ-1: Фильтр журнала принимает диапазон дат',
      'PROJ-1: Кнопка «Сохранить» недоступна без прав',
      'PROJ-1: Экспорт журнала в CSV с фильтром',
      // Пункт из комментария владельца — пункт задачи, как из описания.
      'PROJ-1: Нужен PDF «Отчёт для дизайна» к обеим задачам',
      'PROJ-2: Фильтр журнала принимает диапазон дат',
      'PROJ-2: Экспорт журнала в CSV с фильтром',
    ]);
  });

  it('строка автора комментария сбрасывает раздел состояния прежнего комментария', () => {
    const comments = [
      '## PROJ-4 — Печать',
      '### Comments',
      '**Тестировщик** · 2026-10-26 18:30',
      'h3. Проблема',
      '* Сейчас отчёт падает на пустом журнале',
      '**Владелец** · 2026-10-26 19:00',
      '* Кнопка печати отчёта в шапке',
    ].join('\n');
    expect(ticketPoints(comments).map((point) => point.text)).toEqual([
      'Кнопка печати отчёта в шапке',
    ]);
  });

  it('повтор пункта в одной задаче — один пункт; пустой файл — ни одного', () => {
    const twice =
      '## PROJ-9 — Двойной\n* Один и тот же пункт тикета\n- Один и тот же пункт тикета!\n';
    expect(ticketPoints(twice)).toHaveLength(1);
    expect(ticketPoints(undefined)).toEqual([]);
    expect(ticketPoints('')).toEqual([]);
  });
});

describe('ticket-points: пункт покрыт строкой task-N', () => {
  it('цитата — часть пункта, пункт — часть цитаты, любой статус строки', () => {
    const rows = [
      row('task-1', 'PROJ-1 «Фильтр журнала принимает диапазон» — фильтр в диффе'),
      row(
        'task-2',
        'PROJ-1 «Кнопка «Сохранить» недоступна без прав: проверено ролью наблюдателя»',
        'fail',
      ),
      row('task-3', 'PROJ-1 «Экспорт журнала в CSV с фильтром» — не требование', 'n/a'),
      row('task-4', 'PROJ-1 «Нужен PDF «Отчёт для дизайна» к обеим задачам» — PDF в MR'),
    ];
    expect(unmappedPoints(TICKETS, rows, new Set(['PROJ-1']))).toEqual([]);
  });

  it('строка с ключом другой задачи файла не покрывает одинаковый пункт; без ключа — покрывает оба', () => {
    const keyed = [row('task-1', 'PROJ-1 «Фильтр журнала принимает диапазон дат»')];
    expect(unmappedPoints(TICKETS, keyed)).toContainEqual({
      key: 'PROJ-2',
      points: ['Фильтр журнала принимает диапазон дат', 'Экспорт журнала в CSV с фильтром'],
    });

    const bare = [
      row('task-1', '«Фильтр журнала принимает диапазон дат»'),
      row('task-2', '«Экспорт журнала в CSV с фильтром»'),
    ];
    expect(unmappedPoints(TICKETS, bare, new Set(['PROJ-2']))).toEqual([]);
  });

  it('метка в кавычках, строка не task-N и чужой текст пункт не покрывают', () => {
    const rows = [
      row('task-1', 'PROJ-1 кнопка «Сохранить» — сделано'),
      row('sieve-3', 'PROJ-1 «Фильтр журнала принимает диапазон дат»'),
      row('task-2', 'PROJ-1 «Сортировка журнала по автору записи»'),
    ];
    expect(unmappedPoints(TICKETS, rows, new Set(['PROJ-1']))).toEqual([
      {
        key: 'PROJ-1',
        points: [
          'Фильтр журнала принимает диапазон дат',
          'Кнопка «Сохранить» недоступна без прав',
          'Экспорт журнала в CSV с фильтром',
          'Нужен PDF «Отчёт для дизайна» к обеим задачам',
        ],
      },
    ]);
  });
});

describe('ticket-points: пробел доставки', () => {
  it('след задач отдан — строка на задачу: ключ, счёт, пункты в «…», хвост счётом', () => {
    const many = [
      '## PROJ-7 — Длинная',
      ...Array.from({ length: 8 }, (_, i) => `* Пункт номер ${i + 1} этой длинной задачи`),
    ].join('\n');
    const gaps = ticketPointGaps({ tickets: many, rows: [], required: true });

    expect(codes(gaps)).toEqual(['delivery-gap-task-point-unmapped']);
    expect(matchText(gaps[0] ?? '')?.params).toMatchObject({
      key: 'PROJ-7',
      count: '8',
    });
    expect(gaps[0]).toContain('«Пункт номер 6 этой длинной задачи» (+2)');
    expect(gaps[0]).not.toContain('Пункт номер 7');
  });

  it('след задач не отдан — пробелов нет; все пункты покрыты — тоже', () => {
    expect(ticketPointGaps({ tickets: TICKETS, rows: [], required: false })).toEqual([]);
    const all = [
      row('task-1', '«Фильтр журнала принимает диапазон дат»'),
      row('task-2', '«Кнопка «Сохранить» недоступна без прав»'),
      row('task-3', '«Экспорт журнала в CSV с фильтром»'),
      row('task-4', '«Нужен PDF «Отчёт для дизайна» к обеим задачам»'),
    ];
    expect(ticketPointGaps({ tickets: TICKETS, rows: all, required: true })).toEqual([]);
  });
});

// g1 27.10: 12 строк `task-1298-perms`… молча не покрыли ни одного пункта, группа читала код панели.
describe('ticket-points: строка с приставкой пункта, но не номером', () => {
  it('называет task-/owner- без номера; номерные и прочие id молчат', () => {
    const rows = [
      row('task-1298-perms', '«Фильтр журнала принимает диапазон дат»'),
      row('owner-2b', 'x'),
      row('task-3', 'x'),
      row('owner-1', 'x'),
      row('browser-focus', 'x'),
    ];
    const gaps = misnumberedPointGaps(rows);

    expect(codes(gaps)).toEqual(['delivery-gap-point-id-shape']);
    expect(matchText(gaps[0] ?? '')?.params).toEqual({ ids: 'task-1298-perms, owner-2b' });
    expect(misnumberedPointGaps(rows.slice(2))).toEqual([]);
    expect(misnumberedPointGaps(undefined)).toEqual([]);
  });
});
