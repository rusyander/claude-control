import { describe, expect, it } from 'vitest';
import { deliveryStopOf, humanKindOf, parseDeliveryItem } from './deliveryStop';
import type { ChildStageGroup } from '../ui/ChildStages.types';

const group = (extra: Partial<ChildStageGroup>): ChildStageGroup => ({
  chatId: 'c1',
  title: 'Лимиты',
  stages: ['work'],
  isRunning: false,
  ...extra,
});

describe('parseDeliveryItem — пункт «<сито/блок>: <что не так> — <что сделать>»', () => {
  it('три части', () => {
    expect(parseDeliveryItem('сито «интеграция»: нет записи прогона — прогоните тесты')).toEqual({
      name: 'сито «интеграция»',
      what: 'нет записи прогона',
      todo: 'прогоните тесты',
    });
  });

  it('двоеточие и тире внутри «» и () пункт не делят', () => {
    expect(
      parseDeliveryItem('сито «a: b — c» не пройдено: поле (x — y: z) не описано — добавьте'),
    ).toEqual({
      name: 'сито «a: b — c» не пройдено',
      what: 'поле (x — y: z) не описано',
      todo: 'добавьте',
    });
  });

  it('без имени и без «что сделать» — пункт целиком', () => {
    expect(parseDeliveryItem('ветка agent/g1 не отправлена (или отстаёт от HEAD копии)')).toEqual({
      what: 'ветка agent/g1 не отправлена (или отстаёт от HEAD копии)',
    });
  });

  it('длинное начало до двоеточия — не имя, а фраза', () => {
    const line = `${'очень длинное начало фразы '.repeat(3)}: хвост`;
    expect(parseDeliveryItem(line)).toEqual({ what: line });
  });

  it('незакрытая кавычка не глотает хвост', () => {
    expect(parseDeliveryItem('сито «чужие: удалены строки — верните')).toEqual({
      name: 'сито «чужие',
      what: 'удалены строки',
      todo: 'верните',
    });
  });

  it('точка и «;» в конце снимаются', () => {
    expect(parseDeliveryItem('блок «Тесты» копии: нет прогона;').what).toBe('нет прогона');
  });
});

describe('deliveryStopOf — какая группа читается списком', () => {
  it('пункты — из deliveryMissing, даже когда текст причины склеен иначе', () => {
    const stop = deliveryStopOf(
      group({ error: 'доставка не доведена: что-то', deliveryMissing: ['a: b — c', 'd'] }),
    );
    expect(stop).toEqual({ auto: [{ name: 'a', what: 'b', todo: 'c' }, { what: 'd' }], human: [] });
  });

  it('без deliveryMissing — из текста по «; » вне кавычек', () => {
    const stop = deliveryStopOf(
      group({ error: 'доставка не доведена: сито «x; y»: плохо; ветка не отправлена' }),
    );
    expect(stop?.auto).toEqual([
      { name: 'сито «x; y»', what: 'плохо' },
      { what: 'ветка не отправлена' },
    ]);
  });

  it('по коду причины, даже если текст на другом языке', () => {
    expect(
      deliveryStopOf(
        group({
          error: 'x',
          errorCode: 'split-delivery-incomplete-2',
          deliveryMissing: ['a', 'b'],
        }),
      )?.auto,
    ).toHaveLength(2);
  });

  it('пункт только для человека — в human, по индексу кода; пунктом идёт его what', () => {
    // Форма сервера (split-conveyor HUMAN_CODES): код с params.what, строка — шаблон целиком.
    const stop = deliveryStopOf(
      group({
        error: 'доставка не доведена: a; b',
        deliveryMissing: ['a: b', 'нужен человек — слияние: ветка готова'],
        deliveryMissingCodes: [
          null,
          { messageCode: 'delivery-human-merge' as never, params: { what: 'ветка готова' } },
        ],
      }),
    );
    expect(stop).toEqual({
      auto: [{ name: 'a', what: 'b' }],
      human: [{ kind: 'merge', item: { what: 'ветка готова' } }],
    });
  });

  it('хранилище git копии повреждено — пункт человеку с путём копии, а не дело агента', () => {
    // Форма сервера (onDeliveryFacts, INST-D): params {path, what}, what — текст git.
    const stop = deliveryStopOf(
      group({
        error: 'доставка не доведена: x',
        deliveryMissing: ['нужен человек — хранилище объектов git копии C:/w/copy повреждено: …'],
        deliveryMissingCodes: [
          {
            messageCode: 'delivery-human-corrupt-store' as never,
            params: { path: 'C:/w/copy', what: 'fatal: bad object HEAD' },
          },
        ],
      }),
    );
    expect(stop).toEqual({
      auto: [],
      human: [{ kind: 'corrupt-store', item: { what: 'C:/w/copy' } }],
    });
  });

  it('потолок повторов панели — вид остановки, а не пункт; пробелы за ним — пунктами', () => {
    const stop = deliveryStopOf(
      group({
        error: 'доставка не доведена: x',
        deliveryMissing: [
          'панель повторила доставку сама (повторов: 2) и не довела — продолжите группу словом',
          'a: b',
        ],
        deliveryMissingCodes: [
          { messageCode: 'split-delivery-retry-cap' as never, params: { retries: 3 } },
          null,
        ],
      }),
    );
    expect(stop).toEqual({ auto: [{ name: 'a', what: 'b' }], human: [], stall: 'retry-cap' });
  });

  it('другая причина, группа без чата или без причины — нет', () => {
    expect(deliveryStopOf(group({ error: 'spawn claude ENOENT' }))).toBeUndefined();
    expect(
      deliveryStopOf(group({ pending: 'failed', error: 'доставка не доведена: a' })),
    ).toBeUndefined();
    expect(deliveryStopOf(group({ deliveryMissing: ['a'] }))).toBeUndefined();
  });
});

describe('humanKindOf — пункт только для человека (мерж, разрушительное, доступ)', () => {
  it('по коду сервера', () => {
    expect(humanKindOf('delivery-human-credentials', 'что угодно')).toBe('credentials');
    expect(humanKindOf('delivery-gap-no-mr', 'нет MR')).toBeUndefined();
  });

  it.each([
    ['нужен мерж MR !12', 'merge'],
    ['merge the MR once the pipeline is green', 'merge'],
    ['нужно подтвердить удаление каталога data/', 'destructive'],
    ['перед сдачей нужен force-push ветки', 'destructive'],
    ['confirm the deletion of the volume', 'destructive'],
    ['нет токена доступа к трекеру', 'credentials'],
    ['токен GitLab не задан в проекте', 'credentials'],
    ['missing credentials for the registry', 'credentials'],
  ] as const)('«%s» — %s', (text, kind) => {
    expect(humanKindOf(undefined, text)).toBe(kind);
  });

  // Работа агента, хоть и звучит похоже: слияние с основной (rebase), удаление
  // строк веткой, секрет в диффе, «нет MR».
  it.each([
    'сито «интеграция»: слияние со свежей основной веткой даёт конфликт в a.ts — перенесите ветку (rebase)',
    'сито «чужие −»: ветка удаляет строки, пришедшие в основную — верните их',
    'сито «секреты»: в добавленных строках ключ, токен или приватный ключ: a.ts — уберите его из ветки',
    'нет MR, чья голова — HEAD копии (ветка x) — отправьте ветку и откройте MR',
    'no MR whose head is the copy HEAD (branch x) — push the branch and open the MR',
    'незакоммиченные правки: src/a.ts',
  ])('«%s» — доводит панель', (text) => {
    expect(humanKindOf(undefined, text)).toBeUndefined();
  });
});

/**
 * Остановленная группа сама не продолжит (F-23): причина остановки — первым
 * пунктом `deliveryMissing` с кодом (F-23a), карточка читает из неё, что делать
 * человеку, а сама причина пробелом в списке не идёт.
 */
describe('deliveryStopOf — причина остановки доставки (F-23b)', () => {
  const GAPS = [
    'сито «интеграция»: нет записи прогона — прогоните тесты',
    'незакоммиченные правки: src/a.ts',
  ];
  const REASONS = {
    stalled:
      'напоминание 2 ничего не изменило: та же голова ветки и те же пробелы — посмотрите, что держит группу, и продолжите её словом',
    'nudge-cap':
      'панель напомнила группе 6 раз — это потолок напоминаний; группа двигалась, но не дошла — продолжите её словом',
    'escalation-stalled':
      'разбор доставки на усиленной модели тоже ничего не изменил (после 4 напоминаний): та же голова ветки и те же пробелы — нужен человек',
  } as const;

  it.each(Object.entries(REASONS))(
    'код split-delivery-%s — вид остановки, причина не пункт',
    (kind, reason) => {
      const stop = deliveryStopOf(
        group({
          error: `доставка не доведена: ${[reason, ...GAPS].join('; ')}`,
          errorCode: 'split-delivery-incomplete',
          deliveryMissing: [reason, ...GAPS],
          deliveryMissingCodes: [
            { messageCode: `split-delivery-${kind}` as never, params: { nudges: 2 } },
            null,
            null,
          ],
        }),
      );
      expect(stop?.stall).toBe(kind);
      expect(stop?.auto).toEqual([
        { name: 'сито «интеграция»', what: 'нет записи прогона', todo: 'прогоните тесты' },
        { name: 'незакоммиченные правки', what: 'src/a.ts' },
      ]);
    },
  );

  it('без кода (запись старше кодов) — по тексту, и из текста причины, когда пунктов причины нет', () => {
    expect(
      deliveryStopOf(
        group({
          error: 'доставка не доведена: x',
          deliveryMissing: [REASONS['nudge-cap'], ...GAPS],
        }),
      )?.stall,
    ).toBe('nudge-cap');
    // До F-23a причина жила только в `error`, пункты — одни пробелы.
    const legacy = deliveryStopOf(
      group({
        error: `доставка не доведена: ${[REASONS['escalation-stalled'], ...GAPS].join('; ')}`,
        deliveryMissing: GAPS,
      }),
    );
    expect(legacy?.stall).toBe('escalation-stalled');
    expect(legacy?.auto).toHaveLength(2);
  });

  it('без причины остановки — вида нет', () => {
    expect(
      deliveryStopOf(group({ error: 'доставка не доведена: a', deliveryMissing: GAPS }))?.stall,
    ).toBeUndefined();
  });
});

describe('humanKindOf — команда в пункте агента не делает его пунктом человека (F-96)', () => {
  it.each([
    'сито «команды»: скрипт вызывает rm -rf build — уберите вызов',
    'сито «история»: в ветке был push --force поверх чужих коммитов — верните их обычным коммитом',
    'ветка отстаёт: reset --hard не нужен, перенесите её (rebase)',
    'сито «права»: в Dockerfile sudo без нужды — уберите его',
  ])('«%s» — доводит панель', (text) => {
    expect(humanKindOf(undefined, text)).toBeUndefined();
  });

  it.each([
    'нужно подтвердить rm -rf data/legacy',
    'нужен push --force ветки после переписывания истории',
    'confirm the force-push of the branch',
  ])('«%s» — подтверждение человека', (text) => {
    expect(humanKindOf(undefined, text)).toBe('destructive');
  });
});

describe('parseDeliveryItem — разные тире (F-98)', () => {
  it('делит по первому тире, какого бы вида оно ни было', () => {
    expect(parseDeliveryItem('сито «x»: a – b — c')).toEqual({
      name: 'сито «x»',
      what: 'a',
      todo: 'b — c',
    });
    expect(parseDeliveryItem('сито «x»: a — b – c')).toEqual({
      name: 'сито «x»',
      what: 'a',
      todo: 'b – c',
    });
  });
});
