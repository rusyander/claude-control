import { describe, expect, it } from 'vitest';
import { matchText, serverText } from '../../../lib/server-texts/server-texts.ts';
import { HUMAN_ONLY_LINE } from '../split-continue.ts';
import {
  deliveryEscalationPrompt,
  deliveryNudgePrompt,
  DELIVERY_RETRY_MAX,
  humanAsksOf,
  MAX_DELIVERY_NUDGES,
} from './split-conveyor.ts';
import { harness, NO_MR } from './split-conveyor.escalation.fixture.ts';

/**
 * Почему группа остановлена на доставке и что ей велено — правдой (ревью
 * group-safe-commands, F-23/F-40/F-41/F-49/F-115/F-120). Причина остановки
 * доходит до карточки пунктом `deliveryMissing` с кодом, а не только в `error`,
 * который карточка прячет.
 */

const codeOf = (line: string | undefined) => matchText(line ?? '')?.messageCode;
/**
 * Причина остановки без строки повтора панели: встали напоминания или разбор —
 * группа сначала ждёт повтора (`split-delivery-retry` первым пунктом), и
 * причина идёт за ним.
 */
const reasonLines = (h: ReturnType<typeof harness>): string[] => {
  const missing = h.group()?.deliveryMissing ?? [];
  return codeOf(missing[0]) === 'split-delivery-retry' ? missing.slice(1) : missing;
};
const waitsRetry = (h: ReturnType<typeof harness>) => {
  expect(h.group()).toMatchObject({ status: 'awaiting', waitingFor: 'delivery' });
  expect(codeOf(h.group()?.deliveryMissing?.[0])).toBe('split-delivery-retry');
};
const resume = (h: ReturnType<typeof harness>, chatId: string, stage = 'work') =>
  h.conveyor.onChainResumed(
    { parentChatId: 'родитель', createdAt: '', branch: 'feature/users', stage },
    chatId,
  );

describe('остановка доставки: причина — первым пунктом deliveryMissing', () => {
  // F-23a: причина («встала», «потолок», «и разбор не сдвинул») уходила только в
  // `error`; карточка читала пункты и говорила «панель доводит сама».
  it('разбор не сдвинул — пункт split-delivery-escalation-stalled, за ним пробелы', async () => {
    const same = { missing: [NO_MR], head: 'h1' };
    const h = harness([same, same, same, same, same, same]);
    await h.start();
    await h.round();
    resume(h, 'new-0');
    await h.round();
    resume(h, 'new-escalate', 'deliver');
    await h.round();

    waitsRetry(h);
    const missing = reasonLines(h);
    expect(codeOf(missing[0])).toBe('split-delivery-escalation-stalled');
    expect(missing.slice(1)).toEqual([NO_MR]);
  });

  it('напоминание не сдвинуло, а разбор не завести — пункт split-delivery-stalled', async () => {
    const same = { missing: [NO_MR], head: 'h1' };
    const h = harness([same, same, same, same], { fresh: 'refused' });
    await h.start();
    await h.round();
    resume(h, 'new-0');
    await h.round();

    waitsRetry(h);
    const missing = reasonLines(h);
    expect(codeOf(missing[0])).toBe('split-delivery-stalled');
    expect(missing.slice(1)).toEqual([NO_MR]);
  });

  // F-115: после разбора счёт напоминаний — 1 (первое слово нового круга), и
  // причина говорила «после 1 напоминаний» при шести дошедших.
  it(`после потолка ${MAX_DELIVERY_NUDGES} и разбора причина называет ${MAX_DELIVERY_NUDGES} напоминаний`, async () => {
    const rounds = Array.from({ length: MAX_DELIVERY_NUDGES + 1 }, (_, at) => [
      { missing: [NO_MR], head: `h${at}` },
      { missing: [NO_MR], head: `h${at}` },
    ]).flat();
    const last = { missing: [NO_MR], head: `h${MAX_DELIVERY_NUDGES}` };
    const h = harness([...rounds, last, last]);
    await h.start();
    for (let at = 0; at <= MAX_DELIVERY_NUDGES; at += 1) {
      await h.round();
      resume(h, 'new-0');
    }
    resume(h, 'new-escalate', 'deliver');
    await h.round();

    expect(h.words.at(-1)?.via).toBe('escalate');
    waitsRetry(h);
    const [first] = reasonLines(h);
    expect(matchText(first ?? '')).toMatchObject({
      messageCode: 'split-delivery-escalation-stalled',
      params: { nudges: String(MAX_DELIVERY_NUDGES) },
    });
  });

  // RF-EF-04: число бралось из журнала кругов — тот считает и круги после
  // разбора, и слова в очереди. Одно слово до разбора, разбор сдвинул, ещё два
  // слова, потом встало — «напоминаний до него» одно, а не три.
  it('одно напоминание до разбора, после разбора ещё два — причина называет одно', async () => {
    const at = (head: string) => [
      { missing: [NO_MR], head },
      { missing: [NO_MR], head },
    ];
    const h = harness([...at('h1'), ...at('h1'), ...at('h2'), ...at('h3'), ...at('h3')]);
    await h.start();
    await h.round();
    resume(h, 'new-0');
    await h.round();
    expect(h.words.at(-1)?.via).toBe('escalate');
    resume(h, 'new-escalate', 'deliver');
    await h.round();
    await h.round();
    await h.round();

    expect(h.words.map((word) => word.via)).toEqual(['nudge', 'escalate', 'nudge', 'nudge']);
    waitsRetry(h);
    const [first] = reasonLines(h);
    expect(matchText(first ?? '')).toMatchObject({
      messageCode: 'split-delivery-escalation-stalled',
      params: { nudges: '1' },
    });
  });

  it('слово в очереди занятой группы до разбора в счёт «до него» не идёт', async () => {
    const at = (head: string) => [
      { missing: [NO_MR], head },
      { missing: [NO_MR], head },
    ];
    const h = harness([...at('h1'), ...at('h2'), ...at('h2'), ...at('h2')], { nudge: 'queued' });
    await h.start();
    await h.round();
    resume(h, 'new-0');
    await h.round();
    resume(h, 'new-0');
    await h.round();
    resume(h, 'new-escalate', 'deliver');
    await h.round();

    expect(h.words.map((word) => word.via)).toEqual(['nudge', 'nudge', 'escalate']);
    waitsRetry(h);
    const [first] = reasonLines(h);
    expect(matchText(first ?? '')).toMatchObject({
      messageCode: 'split-delivery-escalation-stalled',
      params: { nudges: '0' },
    });
  });

  // RF-EF-04: число «до разбора» живёт в записи группы — новый круг доставки
  // (сошлась или «Продолжить» человеком) обязан его сбросить, иначе следующая
  // остановка назвала бы число прошлого круга.
  it('доставка сошлась после разбора — число «до него» сброшено', async () => {
    const at = (head: string) => [
      { missing: [NO_MR], head },
      { missing: [NO_MR], head },
    ];
    const h = harness([...at('h1'), ...at('h1')]);
    await h.start();
    await h.round();
    resume(h, 'new-0');
    await h.round();
    expect(h.words.at(-1)?.via).toBe('escalate');
    expect(h.group()?.deliveryEscalatedAfter).toBe(1);
    resume(h, 'new-escalate', 'deliver');
    await h.round();

    expect(h.group()?.deliveryMissing).toBeUndefined();
    expect(h.group()?.deliveryEscalatedAfter).toBeUndefined();
  });

  it('«Продолжить» остановленную после разбора группу — число «до него» сброшено', async () => {
    const same = { missing: [NO_MR], head: 'h1' };
    const h = harness(
      Array.from({ length: 6 + 3 * DELIVERY_RETRY_MAX }, () => same),
      { resume: 'sent' },
    );
    await h.start();
    await h.round();
    resume(h, 'new-0');
    await h.round();
    resume(h, 'new-escalate', 'deliver');
    await h.round();
    // Повторы панели — разбор заново в свой срок; не сдвинул и он — до потолка.
    for (let retry = 1; retry <= DELIVERY_RETRY_MAX; retry += 1) {
      waitsRetry(h);
      await h.fire();
      resume(h, 'new-escalate', 'deliver');
      await h.round();
    }
    expect(h.group()?.status).toBe('failed');
    expect(codeOf(h.group()?.deliveryMissing?.[0])).toBe('split-delivery-retry-cap');
    expect(codeOf(h.group()?.deliveryMissing?.[1])).toBe('split-delivery-escalation-stalled');
    expect(h.group()?.deliveryEscalatedAfter).toBeDefined();
    expect(h.group()?.deliveryRetry?.count).toBe(DELIVERY_RETRY_MAX);

    h.conveyor.continueGroup('родитель', 0, true);
    expect(h.group()?.deliveryEscalatedAfter).toBeUndefined();
    // Слово человека — новый счёт повторов панели.
    expect(h.group()?.deliveryRetry).toBeUndefined();
  });
});

describe('отказ удалённого в доступе — только по тексту ошибки, не по команде', () => {
  // F-40: «401» в имени ветки внутри эха команды стопорило группу «нужен
  // человек: доступ» на обычном таймауте сети.
  it('таймаут ls-remote ветки feat/PROJ-401 — повторная проверка, не стоп «доступ»', async () => {
    const h = harness([
      { missing: [], unreachable: 'Command failed: git ls-remote origin refs/heads/feat/PROJ-401' },
    ]);
    await h.start();
    await h.round();
    expect(h.group()?.status).not.toBe('failed');
    expect(h.group()?.deliveryMissing).toBeUndefined();
  });

  it('HTTP 403 от форджа в тексте ошибки — стоп «доступ»', async () => {
    const h = harness([
      {
        missing: [],
        unreachable:
          'Command failed: git ls-remote origin refs/heads/feat/x\n' +
          'fatal: unable to access https://forge.example.com/app.git/: The requested URL returned error: 403',
      },
    ]);
    await h.start();
    await h.round();
    expect(h.group()?.status).toBe('failed');
    expect(codeOf(h.group()?.deliveryMissing?.[0])).toBe('delivery-human-credentials');
  });
});

describe('метка HUMAN: — только своя строка группы', () => {
  // F-41: проза «The human: merge it…» и эхо шаблона из промпта читались как
  // просьба человеку, и группа с пробелами падала «нужен человек».
  it('проза со словом human и эхо шаблона — не просьба', () => {
    expect(humanAsksOf('The human: merge it after review.')).toEqual([]);
    expect(humanAsksOf(HUMAN_ONLY_LINE)).toEqual([]);
    expect(
      humanAsksOf('I was told to end with `HUMAN: merge|destructive|credentials — <what>`.'),
    ).toEqual([]);
  });

  it('полный текст: строка метки целиком, абзацы после неё и блок кода не в счёт', () => {
    const long = `drop users_old ${'x'.repeat(400)}`;
    expect(
      humanAsksOf(
        [
          'Report.',
          '```text',
          'HUMAN: merge — echoed from a log',
          '```',
          `HUMAN: destructive — ${long}`,
          '',
          'https://forge.example.com/app/-/merge_requests/3',
        ].join('\n'),
      ),
    ).toEqual([{ kind: 'destructive', what: long }]);
    // Ответ с CRLF (Windows) — та же строка метки, без хвоста `\r`.
    expect(humanAsksOf('Report.\r\nHUMAN: merge — MR !12 first\r\nDone.')).toEqual([
      { kind: 'merge', what: 'MR !12 first' },
    ]);
  });

  it('настоящая метка — в начале хвоста и после точки — читается, вид любым регистром', () => {
    expect(humanAsksOf('HUMAN: merge — MR !12 must land first')).toEqual([
      { kind: 'merge', what: 'MR !12 must land first' },
    ]);
    expect(humanAsksOf('Branch is ready. HUMAN: Credentials — no forge token here')).toEqual([
      { kind: 'credentials', what: 'no forge token here' },
    ]);
  });
});

describe('что группа отдаёт человеку — список владельца 23.10, не «системная операция»', () => {
  // «destructive or system-level» отдавал человеку любую «системную» мелочь
  // (пакет, служба, порт): автономия группы — паритет с авто-режимом VS Code,
  // человеку только слияние, удаление, force-push сверх аренды, БД и доступы.
  it('строка называет пять случаев поимённо и не зовёт человека на «системное»', () => {
    expect(HUMAN_ONLY_LINE).toContain('ONLY for: merging into the target branch');
    expect(HUMAN_ONLY_LINE).toContain(
      'a deletion (any git deletion, or anything outside your copy)',
    );
    expect(HUMAN_ONLY_LINE).toContain("a force-push beyond the delivery's lease");
    expect(HUMAN_ONLY_LINE).toContain('a DB migration, DDL or data write');
    expect(HUMAN_ONLY_LINE).toContain('credentials that exist nowhere in the project');
    expect(HUMAN_ONLY_LINE).not.toMatch(/system-level/i);
  });

  it('виды метки — прежние три: удаление, force-push и БД идут видом destructive', () => {
    expect(HUMAN_ONLY_LINE).toMatch(
      /<kind> being merge, destructive \(a deletion, a force-push or a DB write\) or credentials/,
    );
    expect(humanAsksOf('HUMAN: destructive — force-push over the reviewed MR head')).toEqual([
      { kind: 'destructive', what: 'force-push over the reviewed MR head' },
    ]);
  });
});

describe('напоминание о «чужих −» — не rebase и не перезапись ветки', () => {
  // F-49: строка интеграции велела rebase и `--force-with-lease`, а брокер
  // отказывает в перезаписи ветки с MR на ревью без конфликта — группа кружила.
  const removals = serverText('sieve-gap-foreign-removals', { files: 'src/a.ts' });
  const conflicts = serverText('sieve-gap-conflicts', { files: 'src/a.ts' });

  it('только «чужие −» — вернуть строки или назвать файл в отчёте, без force-push', () => {
    for (const prompt of [
      deliveryNudgePrompt('feature/users', [removals]),
      deliveryEscalationPrompt({
        branch: 'feature/users',
        missing: [removals],
        history: [],
        reason: 'cap',
        nudges: 2,
      }),
    ]) {
      expect(prompt).not.toContain('force-with-lease');
      expect(prompt).not.toContain('git rebase');
      expect(prompt).toContain('foreign-removals row');
    }
  });

  it('конфликт со свежей основной — по-прежнему rebase и lease-push', () => {
    expect(deliveryNudgePrompt('feature/users', [conflicts])).toContain(
      'git push --force-with-lease origin feature/users',
    );
  });
});

describe('напоминание в сессию работы', () => {
  // F-120 (не подтвердилось): группа ждёт сверки доставки (`awaiting/delivery`),
  // звена доставки впереди уже нет — ход напоминания идёт без запрета пуша и MR.
  it('ход напоминания собирается без запрета пуша (deliverAhead = false)', async () => {
    const h = harness([
      { missing: [NO_MR], head: 'h1' },
      { missing: [NO_MR], head: 'h1' },
    ]);
    await h.start();
    await h.round();
    expect(h.words).toEqual([expect.objectContaining({ via: 'nudge', deliverAhead: false })]);
  });
});
