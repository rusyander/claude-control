import { describe, expect, it } from 'vitest';
import { matchText } from '../../../lib/server-texts/server-texts.ts';
import {
  deliveryEscalationPrompt,
  deliveryNudgePrompt,
  humanAsksOf,
  MAX_DELIVERY_NUDGES,
} from './split-conveyor.ts';
import { harness, NO_MR } from './split-conveyor.escalation.fixture.ts';

/**
 * Доставка доводится агентами, а не карточкой «решение за вами» (решение
 * владельца 23.10). Живая группа: четыре напоминания «откройте MR» ушли в
 * сессию ревью без `create_merge_request`, после двух напоминаний — `failed`.
 * Теперь: сессии, которой MR не открыть, — новая стадия доставки; вставшие или
 * кончившиеся напоминания — один разбор на сильной модели с историей кругов;
 * сдача — только если не сдвинул и он.
 */

describe('напоминание: кейс, которого здесь не выполнить', () => {
  it('говорит записать его blocked с причиной, а не оставить непрогнанным', () => {
    const prompt = deliveryNudgePrompt('feature/users', [NO_MR]);
    expect(prompt).toContain('=blocked --note');
    expect(prompt).toContain('recorded as blocked, not left unrun');
  });
});

describe('доставка: стадия, которой MR не открыть', () => {
  it('сессия ревью — новый разговор стадией доставки, а не напоминание в ревью', async () => {
    const h = harness(
      [
        { missing: [NO_MR], head: 'h1' },
        { missing: [NO_MR], head: 'h1' },
      ],
      { stage: 'review' },
    );
    await h.start();
    await h.round();

    expect(h.words.map((word) => word.via)).toEqual(['deliver']);
    expect(h.words[0]?.prompt).toContain('open the MR yourself');
    // Старт хода перевёл группу на новый разговор — счёт лёг в ту же запись.
    expect(h.group()).toMatchObject({
      chatId: 'new-deliver',
      status: 'started',
      deliveryNudges: 1,
      deliveryMissing: [NO_MR],
    });
    expect(h.group()?.deliveryHistory).toHaveLength(1);
  });

  it('сессия работы — обычное напоминание; не ушло — новая доставка, а не failed', async () => {
    const h = harness(
      [
        { missing: [NO_MR], head: 'h1' },
        { missing: [NO_MR], head: 'h1' },
      ],
      { stage: 'work', nudge: 'refused' },
    );
    await h.start();
    await h.round();

    expect(h.words.map((word) => word.via)).toEqual(['nudge', 'deliver']);
    expect(h.group()?.status).not.toBe('failed');
  });
});

describe('разбор: история кругов без повторов', () => {
  // Форма живой записи !1072 (24.10): длинный пробел «чужие −» в каждом круге.
  const long = (name: string): string =>
    `${name}: ${'inst-chat-ui/src/app/x/index.tsx, '.repeat(30)}`;
  const A = long('foreign-removals sieve');
  const B = long('sieve consumers-repo-wide');
  const C = long('sieve project-checks');
  const history = [
    { at: 't1', head: 'ede4693e56d16a443b0829db7c70c60664943fb8', missing: [A, B] },
    { at: 't2', head: '5970eeb28a456d323f02368cf912ea03bf772b92', missing: [A, B] },
    { at: 't3', head: '8583f276ddab5aba231de49275467cb272981917', missing: [A, C] },
  ];
  const prompt = deliveryEscalationPrompt({
    branch: 'feature/users',
    missing: [C],
    history,
    reason: 'cap',
    nudges: 6,
  });
  const section = prompt.slice(
    prompt.indexOf('Earlier rounds'),
    prompt.indexOf('Restore the state'),
  );

  it('круг с теми же пробелами — одной строкой, новый пробел — началом, перешедшие — счётом', () => {
    expect(section).toContain('- t2, head 5970eeb28a45: same gaps as the round before');
    expect(section).toMatch(
      /- t3, head 8583f276ddab: sieve project-checks: [^;]{0,200}…; \+1 from the round before/,
    );
    expect(section).not.toContain(A);
  });

  it('полный текст нынешнего пробела — в «Gaps now», история короче одного такого пробела на круг', () => {
    expect(prompt).toContain(`- ${C}`);
    expect(section.length).toBeLessThan(history.length * 600);
  });
});

describe('доставка: напоминания встали — разбор на сильной модели', () => {
  it('напоминание ничего не изменило — один разбор с историей кругов, без failed', async () => {
    const same = { missing: [NO_MR], head: 'h1' };
    const h = harness([same, same, same, same]);
    await h.start();
    await h.round();
    h.conveyor.onChainResumed(
      { parentChatId: 'родитель', createdAt: '', branch: 'feature/users', stage: 'work' },
      'new-0',
    );
    await h.round();

    expect(h.words.map((word) => word.via)).toEqual(['nudge', 'escalate']);
    const prompt = h.words[1]?.prompt ?? '';
    expect(prompt).toContain('NEW diagnose-and-fix run');
    expect(prompt).toContain('the reminder 1 changed nothing');
    // История: круг первого напоминания с его головой и пробелом.
    expect(prompt).toMatch(/Earlier rounds[\s\S]*head h1: no MR/);
    expect(prompt).toContain('ONLY for: merging into the target branch');
    expect(h.group()?.status).not.toBe('failed');
    expect(h.group()?.deliveryEscalatedAt).toBeTruthy();
  });

  it('разбор тоже ничего не изменил — не failed, а повтор разбора панелью через срок', async () => {
    const same = { missing: [NO_MR], head: 'h1' };
    const h = harness([same, same, same, same, same, same]);
    const resume = (chatId: string) =>
      h.conveyor.onChainResumed(
        { parentChatId: 'родитель', createdAt: '', branch: 'feature/users', stage: 'deliver' },
        chatId,
      );
    await h.start();
    await h.round();
    resume('new-0');
    await h.round();
    // Ход идёт в разговоре разбора — та же стадия доставки, счёт не сбрасывается.
    resume('new-escalate');
    await h.round();

    expect(h.words.map((word) => word.via)).toEqual(['nudge', 'escalate']);
    // Агенты могут снять это сами (решение владельца 23.10): группа ждёт повтора,
    // а не стоит `failed`, которого не трогает никто (трасса автономии 24.10, §2).
    expect(h.group()).toMatchObject({ status: 'awaiting', waitingFor: 'delivery' });
    expect(h.group()?.deliveryRetry).toMatchObject({ count: 1, kind: 'escalate' });
    expect(h.group()?.deliveryMissing?.[0]).toContain('панель повторит сама через 30 мин');
    expect(h.group()?.deliveryMissing?.[1]).toContain(
      'разбор доставки на усиленной модели тоже ничего не изменил',
    );
    expect(h.group()?.deliveryMissing?.slice(2)).toEqual([NO_MR]);
  });

  it(`потолок ${MAX_DELIVERY_NUDGES} напоминаний — тоже разбор, а не failed`, async () => {
    const rounds = Array.from({ length: MAX_DELIVERY_NUDGES + 1 }, (_, at) => [
      { missing: [NO_MR], head: `h${at}` },
      { missing: [NO_MR], head: `h${at}` },
    ]).flat();
    const h = harness(rounds);
    await h.start();
    for (let at = 0; at <= MAX_DELIVERY_NUDGES; at += 1) {
      await h.round();
      h.conveyor.onChainResumed(
        { parentChatId: 'родитель', createdAt: '', branch: 'feature/users', stage: 'work' },
        'new-0',
      );
    }

    const vias = h.words.map((word) => word.via);
    expect(vias.filter((via) => via === 'nudge')).toHaveLength(MAX_DELIVERY_NUDGES);
    expect(vias.at(-1)).toBe('escalate');
    expect(h.words.at(-1)?.prompt).toContain(`${MAX_DELIVERY_NUDGES} reminders did not finish it`);
    expect(h.group()?.status).not.toBe('failed');
  });

  it('новой стадии завести нечем — как раньше: failed сразу, с причиной', async () => {
    const same = { missing: [NO_MR], head: 'h1' };
    const h = harness([same, same, same, same], { fresh: 'none' });
    await h.start();
    await h.round();
    await h.round();

    expect(h.words.map((word) => word.via)).toEqual(['nudge']);
    expect(h.group()?.status).toBe('failed');
    expect(h.group()?.error).toContain('напоминание 1 ничего не изменило');
  });
});

// Разбор остановок 23.10, D3: напоминание в сессию работы (пуш закрыт) съедало
// запас доставки, а у другой группы стояло «2 из 2» при одном дошедшем слове.
describe('доставка: счёт напоминаний — на стадию и только дошедшие', () => {
  it('группа перешла в другую стадию — счёт заново, тот же ключ не «встал»', async () => {
    const same = { missing: [NO_MR], head: 'h1' };
    const h = harness([same, same, same, same], { fresh: 'none' });
    await h.start();
    await h.round();
    expect(h.group()?.deliveryNudges).toBe(1);

    // Планировщик завёл звено доставки: тот же HEAD и пробелы, но стадия другая.
    h.stageOfChat.value = 'deliver';
    h.conveyor.onChainResumed(
      { parentChatId: 'родитель', createdAt: '', branch: 'feature/users', stage: 'deliver' },
      'new-0',
    );
    await h.round();

    expect(h.words.map((word) => word.via)).toEqual(['nudge', 'nudge']);
    expect(h.group()).toMatchObject({ deliveryNudges: 1, deliveryNudgeStage: 'deliver' });
    expect(h.group()?.status).not.toBe('failed');
  });

  it('слово легло в очередь занятой группы — в счёт не идёт', async () => {
    const h = harness(
      [
        { missing: [NO_MR], head: 'h1' },
        { missing: [NO_MR], head: 'h1' },
      ],
      { nudge: 'queued' },
    );
    await h.start();
    await h.round();

    expect(h.words.map((word) => word.via)).toEqual(['nudge']);
    expect(h.group()?.deliveryNudges ?? 0).toBe(0);
    expect(h.group()?.deliveryNudgeKey).toBeTruthy();
  });
});

// Карточка остановки читает пункты «нужен человек» по коду
// `delivery-human-merge|destructive|credentials` (решение владельца 23.10:
// человеку — только мерж, разрушительное и доступ, которого нет нигде).
describe('доставка: то, что можно только человеку', () => {
  const codeOf = (line: string | undefined) => matchText(line ?? '')?.messageCode;

  it('группа написала «HUMAN: credentials — …» — стоп сразу, пункт с кодом первым, без напоминаний', async () => {
    const h = harness([
      { missing: [NO_MR], head: 'h1' },
      { missing: [NO_MR], head: 'h1' },
    ]);
    await h.start();
    await h.round(
      'Ветка готова локально. HUMAN: credentials — no forge token for the MR API in this project',
    );

    expect(h.words).toEqual([]);
    expect(h.group()?.status).toBe('failed');
    const missing = h.group()?.deliveryMissing ?? [];
    expect(codeOf(missing[0])).toBe('delivery-human-credentials');
    expect(missing[0]).toContain('no forge token for the MR API');
    expect(missing[1]).toBe(NO_MR);
  });

  // Хвост ответа — последний абзац, обрезанный до 280 знаков СПЕРЕДИ: длинная
  // строка `HUMAN:` теряла саму метку, и группа вместо стопа получала напоминания.
  it('длинная строка HUMAN: — стоп с её началом, а не напоминание', async () => {
    const h = harness([
      { missing: [NO_MR], head: 'h1' },
      { missing: [NO_MR], head: 'h1' },
    ]);
    await h.start();
    const why = `the MR API answers 401 for the deploy token ${'and the project has no other token '.repeat(9)}`;
    await h.round(`Ветка готова локально.\n\nHUMAN: credentials — START-OF-ASK ${why}`);

    expect(h.words).toEqual([]);
    expect(h.group()?.status).toBe('failed');
    const missing = h.group()?.deliveryMissing ?? [];
    expect(codeOf(missing[0])).toBe('delivery-human-credentials');
    expect(missing[0]).toContain('START-OF-ASK the MR API answers 401');
  });

  it('абзац HUMAN:, а последней строкой — ссылка MR: всё равно стоп', async () => {
    const h = harness([
      { missing: [NO_MR], head: 'h1' },
      { missing: [NO_MR], head: 'h1' },
    ]);
    await h.start();
    await h.round(
      'HUMAN: merge — MR !12 must land before this one\n\nhttps://forge.example.com/app/-/merge_requests/3',
    );

    expect(h.words).toEqual([]);
    expect(codeOf(h.group()?.deliveryMissing?.[0])).toBe('delivery-human-merge');
  });

  it('удалённый отказал в доступе — не четыре часа повторов, а пункт «доступ»', async () => {
    const h = harness([
      {
        missing: [],
        unreachable: 'fatal: Authentication failed for https://forge.example.com/app.git',
      },
    ]);
    await h.start();
    await h.round();

    expect(h.group()?.status).toBe('failed');
    expect(codeOf(h.group()?.deliveryMissing?.[0])).toBe('delivery-human-credentials');
    expect(h.words).toEqual([]);
  });

  it('сеть молчит (не доступ) — по-прежнему повторная проверка, а не стоп', async () => {
    const h = harness([
      { missing: [], unreachable: 'ssh: connect to host forge port 22: timed out' },
    ]);
    await h.start();
    await h.round();
    expect(h.group()?.status).not.toBe('failed');
  });

  it('несколько меток в хвосте — по пункту на каждую; без метки — пусто', () => {
    expect(
      humanAsksOf(
        '`HUMAN: merge — MR !12 must land before this one` `HUMAN: destructive — drop the legacy table users_old`',
      ),
    ).toEqual([
      { kind: 'merge', what: 'MR !12 must land before this one' },
      { kind: 'destructive', what: 'drop the legacy table users_old' },
    ]);
    expect(humanAsksOf('Готово, MR: https://forge.example.com/app/-/merge_requests/3')).toEqual([]);
  });
});
