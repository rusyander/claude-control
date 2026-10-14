import { describe, it, expect } from 'vitest';
import {
  SplitReview,
  reviewNoticeText,
  reviewSummaryComment,
  type SplitReviewDeps,
} from './split-review.ts';
import { OWNER_REQUEST_OPENER } from '@agentdeck/contracts/quality-floor';
import type { ChatLink } from '../../../lib/app-store/app-store.types.ts';

/**
 * Ревью чужого MR по ссылке (Т7).
 *
 * Проверяется ровно то, чем эта штука может навредить: написать в чужой MR или
 * переписать чужую ветку без человека. Всё остальное (сколько замечаний, как они
 * сформулированы) — дело модели, и тестами не ловится.
 */

const URL = 'https://gitlab.com/team/app/-/merge_requests/42';

function reviewLink(overrides: Partial<ChatLink> = {}): ChatLink {
  return {
    parentChatId: 'parent',
    title: 'MR 42',
    branch: 'feature/login',
    createdAt: '2026-09-09T10:00:00.000Z',
    stage: 'review',
    model: 'opus',
    effort: 'high',
    review: { url: URL, branch: 'feature/login', path: '/copies/feature-login' },
    ...overrides,
  };
}

/** Стенд: связи в памяти, запуск и запись в MR — записываются, а не делаются. */
function stand(
  options: {
    post?: SplitReviewDeps['post'];
    blocked?: string;
    /**
     * Ключ, который вернёт запуск. Так отвечает чужой CLI: разговор заводит его
     * хранилище, и настоящий ключ известен только после создания.
     */
    realKey?: string;
    started?: boolean;
    /** Запуск отказал, потому что разговор ещё идёт. */
    busy?: boolean;
    /** Публикует сессия ревью, а не сводный комментарий панели. */
    publishInSession?: boolean;
  } = {},
) {
  const links: Record<string, ChatLink> = {};
  const started: {
    chatId: string;
    prompt: string;
    cwd: string;
    stage: string;
    resume?: string;
    fresh?: string;
  }[] = [];
  const closed: ChatLink[] = [];
  const posted: { url: string; body: string }[] = [];
  const events: { parent: string; event: unknown }[] = [];

  const review = new SplitReview({
    store: {
      all: () => links,
      set: (chatId, link) => void (links[chatId] = link),
      remove: (chatId) => void delete links[chatId],
    },
    post:
      options.post ??
      (async (url, body) => {
        posted.push({ url, body });
      }),
    ...(options.blocked ? { postBlocked: () => options.blocked } : {}),
    ...(options.publishInSession ? { publishInSession: true } : {}),
    start: (input) => {
      started.push({
        chatId: input.chatId,
        prompt: input.prompt,
        cwd: input.cwd,
        stage: input.stage,
        ...(input.resume ? { resume: input.resume.sessionId } : {}),
        ...(input.fresh ? { fresh: input.fresh } : {}),
      });
      if (options.busy) return { started: false, busy: true };
      return {
        started: options.started ?? true,
        ...(options.realKey ? { chatId: options.realKey } : {}),
      };
    },
    closeGroup: (link) => void closed.push(link),
    emit: (parent, event) => {
      events.push({ parent, event });
      return true;
    },
    log: () => {},
    now: () => new Date('2026-09-09T12:00:00.000Z'),
  });

  return { review, links, started, posted, events, closed };
}

/** Полный отчёт о глубине при T0: ни дочитывать, ни звать свидетеля не за чем. */
const FULL_T0 = { tier: 'T0', entries: ['diff-first'], coverage: 'full', uncovered: [] };

/** Ответ ревьюера в том виде, в каком его печатает модель; `null` — без отчёта о глубине. */
function answer(findings: string[], depth: object | null = FULL_T0): string {
  const block = depth ? { findings, depth } : { findings };
  return ['Посмотрел дифф.', '```agentdeck:review', JSON.stringify(block), '```'].join('\n');
}

describe('конец прогона ревью', () => {
  it('пустой список замечаний закрывает группу без карточки', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink();

    const event = review.finished({
      chatId: 'c1',
      aliases: ['c1'],
      link: links.c1 as ChatLink,
      ok: true,
      text: answer([]),
    });

    expect(links.c1?.review?.findings).toEqual([]);
    expect(links.c1?.review?.decision).toBe('none');
    expect(links.c1?.review?.decidedAt).toBe('2026-09-09T12:00:00.000Z');
    expect(event).toMatchObject({ kind: 'review', decided: true, findings: [] });
    // Ничего не запущено: закрытая чистой группа — конец истории.
    expect(started).toEqual([]);
  });

  it('замечания ложатся в связь, но ничего не запускают: решает человек', () => {
    const { review, links, started, posted } = stand();
    links.c1 = reviewLink();

    const event = review.finished({
      chatId: 'c1',
      aliases: ['c1'],
      link: links.c1 as ChatLink,
      ok: true,
      text: answer(['src/a.ts:10 — забыт await', 'src/b.ts — нет теста']),
    });

    expect(links.c1?.review?.findings).toHaveLength(2);
    expect(links.c1?.review?.decidedAt).toBeUndefined();
    expect(event).toMatchObject({ kind: 'review', url: URL });
    expect(started).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('пишет замечания по ОБОИМ ключам разговора: связь живёт под двумя', () => {
    const { review, links } = stand();
    const link = reviewLink();
    links['new-1'] = link;
    links['session-1'] = link;

    review.finished({
      chatId: 'new-1',
      aliases: ['new-1', 'session-1'],
      link,
      ok: true,
      text: answer(['одно замечание']),
    });

    expect(links['new-1']?.review?.findings).toEqual(['одно замечание']);
    expect(links['session-1']?.review?.findings).toEqual(['одно замечание']);
  });

  it('второй прогон в том же чате список не перезаписывает', () => {
    const { review, links } = stand();
    links.c1 = reviewLink();
    review.finished({
      chatId: 'c1',
      aliases: ['c1'],
      link: links.c1 as ChatLink,
      ok: true,
      text: answer(['первое']),
    });

    review.finished({
      chatId: 'c1',
      aliases: ['c1'],
      link: links.c1 as ChatLink,
      ok: true,
      text: answer(['совсем другое']),
    });

    expect(links.c1?.review?.findings).toEqual(['первое']);
  });

  it('упавший прогон замечаний не пишет: пустой список закрыл бы группу как чистую', () => {
    const { review, links } = stand();
    links.c1 = reviewLink();

    const event = review.finished({
      chatId: 'c1',
      aliases: ['c1'],
      link: links.c1 as ChatLink,
      ok: false,
      text: answer([]),
    });

    expect(event).toBeUndefined();
    expect(links.c1?.review?.findings).toBeUndefined();
  });

  it('обычная группа разделения событий ревью не даёт', () => {
    const { review, links } = stand();
    links.c1 = { parentChatId: 'parent', createdAt: 'now', stage: 'work' };

    expect(
      review.finished({
        chatId: 'c1',
        aliases: ['c1'],
        link: links.c1 as ChatLink,
        ok: true,
        text: answer(['что-то']),
      }),
    ).toBeUndefined();
  });
});

describe('решение человека', () => {
  /** Связь, у которой ревью уже посчитано и ждёт решения. */
  function waiting(findings = ['src/a.ts:10 — забыт await']): ChatLink {
    return reviewLink({ review: { url: URL, branch: 'feature/login', path: '/copy', findings } });
  }

  it('«исправить» заводит правки по списку в копии и в MR не пишет', async () => {
    const { review, links, started, posted } = stand();
    links.c1 = waiting();

    const outcome = await review.decide({ chatId: 'c1', decision: 'fix' });

    expect(started).toHaveLength(1);
    expect(started[0]?.stage).toBe('fix');
    expect(started[0]?.cwd).toBe('/copy');
    expect(started[0]?.prompt).toContain('забыт await');
    expect(posted).toEqual([]);
    expect(outcome.applied[0]?.fixChatId).toBe(started[0]?.chatId);
    expect(links.c1?.review?.decision).toBe('fix');
    // Связь чата правок несёт ревью с собой: после них будет что предлагать.
    const fixLink = links[started[0]?.chatId ?? ''];
    expect(fixLink?.stage).toBe('fix');
    expect(fixLink?.review?.url).toBe(URL);
  });

  it('правки по ревью знают, что просил человек и какой это MR (F11)', async () => {
    const { review, links, started } = stand();
    links.c1 = { ...waiting(), groupTask: 'Посмотри этот MR, особенно миграции' };

    await review.decide({ chatId: 'c1', decision: 'fix' });

    expect(started[0]?.prompt).toContain('Посмотри этот MR, особенно миграции');
    expect(started[0]?.prompt).toContain(URL);
  });

  it('чат правок — другой разговор: ключа разговора группы он не наследует (Д11)', async () => {
    const { review, links, started } = stand();
    links.c1 = { ...waiting(), conversation: 'new-group' };
    links['sess-group'] = links.c1;

    await review.decide({ chatId: 'c1', decision: 'fix' });

    const fixLink = links[started[0]?.chatId ?? ''];
    expect(fixLink?.parentChatId).toBe(links.c1.parentChatId);
    expect(fixLink?.conversation).toBeUndefined();
  });

  it('«отписать» пишет ОДИН сводный комментарий и правок не заводит', async () => {
    const { review, links, started, posted } = stand();
    links.c1 = waiting(['src/a.ts:10 — забыт await', 'src/b.ts — нет теста']);

    await review.decide({ chatId: 'c1', decision: 'post' });

    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe(URL);
    expect(posted[0]?.body).toContain('1. src/a.ts:10 — забыт await');
    expect(posted[0]?.body).toContain('2. src/b.ts — нет теста');
    expect(started).toEqual([]);
    expect(links.c1?.review?.postedAt).toBe('2026-09-09T12:00:00.000Z');
  });

  it('отказ форджа не отменяет правок, а причина остаётся на карточке', async () => {
    const { review, links, started } = stand({
      post: async () => {
        throw new Error('403 Forbidden\nвторая строка, которой в интерфейсе не место');
      },
    });
    links.c1 = waiting();

    const outcome = await review.decide({ chatId: 'c1', decision: 'both' });

    expect(started).toHaveLength(1);
    expect(outcome.applied[0]?.postError).toBe('403 Forbidden');
    expect(links.c1?.review?.postError).toBe('403 Forbidden');
    expect(links.c1?.review?.postedAt).toBeUndefined();
  });

  it('без интеграции кнопка отписать не молчит: причина уезжает в связь и в вид', async () => {
    const { review, links } = stand({ blocked: 'токен форджа не сохранён' });
    links.c1 = waiting();

    await review.decide({ chatId: 'c1', decision: 'post' });

    expect(links.c1?.review?.postError).toBe('токен форджа не сохранён');
    expect(review.view(links.c1 as ChatLink)?.postBlocked).toBe('токен форджа не сохранён');
  });

  it('«ничего» закрывает карточку и не запускает ровно ничего', async () => {
    const { review, links, started, posted } = stand();
    links.c1 = waiting();

    await review.decide({ chatId: 'c1', decision: 'none' });

    expect(started).toEqual([]);
    expect(posted).toEqual([]);
    expect(links.c1?.review?.decision).toBe('none');
    expect(links.c1?.review?.decidedAt).toBe('2026-09-09T12:00:00.000Z');
  });

  it('повторный клик вторых правок не заводит', async () => {
    const { review, links, started } = stand();
    links.c1 = waiting();

    await review.decide({ chatId: 'c1', decision: 'fix' });
    const second = await review.decide({ chatId: 'c1', decision: 'fix' });

    expect(started).toHaveLength(1);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['c1']);
  });

  it('после отказа форджа отписать можно ещё раз — и вторых правок это не заводит', async () => {
    let refuse = true;
    const bodies: string[] = [];
    const { review, links, started } = stand({
      post: async (_url, body) => {
        bodies.push(body);
        if (refuse) throw new Error('502 Bad Gateway');
      },
    });
    links.c1 = waiting();

    const first = await review.decide({ chatId: 'c1', decision: 'both' });
    expect(first.applied[0]?.postError).toBe('502 Bad Gateway');
    expect(started).toHaveLength(1);

    // Фордж поднялся — человек жмёт «Отписать» ещё раз. Замечания обязаны
    // уехать: иначе они не попадут в MR уже никогда.
    refuse = false;
    const second = await review.decide({ chatId: 'c1', decision: 'post' });

    expect(second.applied[0]?.posted).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(links.c1?.review?.postedAt).toBe('2026-09-09T12:00:00.000Z');
    expect(links.c1?.review?.postError).toBeUndefined();
    // Повтор — только ветка записи: правки уже заведены первым решением.
    expect(started).toHaveLength(1);
  });

  it('удавшуюся запись в MR повтором не дублируем', async () => {
    const { review, links, posted } = stand();
    links.c1 = waiting();

    await review.decide({ chatId: 'c1', decision: 'post' });
    const second = await review.decide({ chatId: 'c1', decision: 'post' });

    expect(posted).toHaveLength(1);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['c1']);
  });

  it('«применить ко всем» решает ждущие группы дерева и не трогает решённые', async () => {
    const { review, links, started } = stand();
    links.c1 = waiting(['первое']);
    links.c2 = waiting(['второе']);
    links.c3 = reviewLink({
      review: {
        url: URL,
        path: '/copy3',
        findings: ['третье'],
        decision: 'none',
        decidedAt: 'вчера',
      },
    });
    // Чужое дерево: «ко всем» — это ко всем СВОИМ.
    links.c4 = reviewLink({ parentChatId: 'другой', review: { url: URL, findings: ['чужое'] } });

    const outcome = await review.decide({ chatId: 'c1', decision: 'fix', applyToAll: true });

    expect(outcome.applied.map((item) => item.chatId).sort()).toEqual(['c1', 'c2']);
    expect(started).toHaveLength(2);
    expect(links.c3?.review?.decision).toBe('none');
    expect(links.c4?.review?.decision).toBeUndefined();
  });

  it('клик из чужого дерева не решает ничего: вкладка помнит старое разделение', async () => {
    const { review, links, started, posted } = stand();
    links.c1 = waiting();

    const outcome = await review.decide({
      chatId: 'c1',
      decision: 'both',
      parentChatId: 'другой',
    });

    expect(outcome.applied).toEqual([]);
    expect(started).toEqual([]);
    expect(posted).toEqual([]);
    expect(links.c1?.review?.decision).toBeUndefined();
  });

  it('родитель, известный вторым ключом, чужим не считается', async () => {
    const { review, links, started } = stand();
    const parent: ChatLink = { parentChatId: 'дед', createdAt: 'вчера', stage: 'work' };
    links['new-parent'] = parent;
    links['session-parent'] = parent;
    links.c1 = { ...waiting(), parentChatId: 'new-parent' };

    const outcome = await review.decide({
      chatId: 'c1',
      decision: 'fix',
      parentChatId: 'session-parent',
    });

    expect(outcome.applied).toHaveLength(1);
    expect(started).toHaveLength(1);
  });

  it('группа без замечаний решению не подлежит: там уже всё закрыто', async () => {
    const { review, links } = stand();
    links.c1 = reviewLink({ review: { url: URL, findings: [], decision: 'none', decidedAt: 'x' } });

    const outcome = await review.decide({ chatId: 'c1', decision: 'post' });

    expect(outcome.applied).toEqual([]);
  });
});

describe('отправка правок в MR', () => {
  it('после правок панель предлагает отправить, но сама не отправляет', () => {
    const { review, links, started } = stand();
    links.fix = reviewLink({
      stage: 'fix',
      review: { url: URL, branch: 'feature/login', path: '/copy', findings: ['одно'] },
    });

    const event = review.finished({
      chatId: 'fix',
      aliases: ['fix'],
      link: links.fix as ChatLink,
      ok: true,
      text: 'Поправил.',
    });

    expect(event).toMatchObject({ kind: 'review', pushOffer: true });
    expect(links.fix?.review?.pushOffer).toBe(true);
    expect(started).toEqual([]);
  });

  it('клик заводит стадию push с явным согласием в задании', () => {
    const { review, links, started } = stand();
    links.fix = reviewLink({
      stage: 'fix',
      review: {
        url: URL,
        branch: 'feature/login',
        path: '/copy',
        findings: ['одно'],
        pushOffer: true,
      },
    });

    const outcome = review.push({ chatId: 'fix' });

    expect(started).toHaveLength(1);
    expect(started[0]?.stage).toBe('push');
    expect(started[0]?.prompt).toContain('this is explicit consent to commit and push');
    expect(started[0]?.prompt).toContain('feature/login');
    expect(outcome.applied[0]?.pushChatId).toBe(started[0]?.chatId);
    expect(links.fix?.review?.pushedAt).toBe('2026-09-09T12:00:00.000Z');
    expect(links.fix?.review?.pushOffer).toBe(false);
  });

  it('второй клик ничего не отправляет', () => {
    const { review, links, started } = stand();
    links.fix = reviewLink({
      stage: 'fix',
      review: {
        url: URL,
        branch: 'feature/login',
        path: '/copy',
        findings: ['одно'],
        pushOffer: true,
      },
    });

    review.push({ chatId: 'fix' });
    const second = review.push({ chatId: 'fix' });

    expect(started).toHaveLength(1);
    expect(second.applied).toEqual([]);
  });

  it('push продолжает СЕССИЮ правок, а не заводит новый чат в той же копии (Д8)', () => {
    const { review, links, started } = stand();
    const fix = reviewLink({
      stage: 'fix',
      conversation: 'conv-fix',
      review: {
        url: URL,
        branch: 'feature/login',
        path: '/copy',
        findings: ['одно'],
        pushOffer: true,
      },
    });
    // Связь живёт под временным ключом и под настоящим ключом сессии.
    links['new-1-fix0'] = fix;
    links['sess-fix'] = fix;

    const outcome = review.push({ chatId: 'new-1-fix0' });

    expect(started).toHaveLength(1);
    expect(started[0]?.chatId).toBe('sess-fix');
    expect(started[0]?.resume).toBe('sess-fix');
    expect(outcome.applied[0]?.pushChatId).toBe('sess-fix');
    // Нового чата в дереве нет: ключей столько же, сколько было.
    expect(Object.keys(links).sort()).toEqual(['new-1-fix0', 'sess-fix']);
    expect(links['sess-fix']?.review?.pushedAt).toBe('2026-09-09T12:00:00.000Z');
    expect(links['new-1-fix0']?.review?.pushedAt).toBe('2026-09-09T12:00:00.000Z');
  });

  it('копия в detached HEAD — push идёт в ветку MR через HEAD:<ветка> (Д9)', () => {
    const { review, links, started } = stand();
    links.fix = reviewLink({
      stage: 'fix',
      review: {
        url: URL,
        branch: 'feature/login',
        remote: 'upstream',
        detached: true,
        path: '/copy',
        findings: ['одно'],
        pushOffer: true,
      },
    });

    review.push({ chatId: 'fix' });

    expect(started[0]?.prompt).toContain('git push upstream HEAD:feature/login');
  });

  it('ветка MR неизвестна — push отказан с причиной и не запускается (Д9)', () => {
    const { review, links, started } = stand();
    links.fix = reviewLink({
      stage: 'fix',
      review: { url: URL, path: '/copy', findings: ['одно'], pushOffer: true },
    });

    const outcome = review.push({ chatId: 'fix' });

    expect(started).toEqual([]);
    expect(outcome.applied[0]?.refused).toBe('branch-unknown');
    expect(links.fix?.review?.pushedAt).toBeUndefined();
  });

  it('чат правок ещё работает — отказ, кнопка остаётся (Д8)', () => {
    const { review, links } = stand({ busy: true });
    links.fix = reviewLink({
      stage: 'fix',
      review: {
        url: URL,
        branch: 'feature/login',
        path: '/copy',
        findings: ['одно'],
        pushOffer: true,
      },
    });

    const outcome = review.push({ chatId: 'fix' });

    expect(outcome.applied[0]?.refused).toBe('busy');
    expect(links.fix?.review?.pushOffer).toBe(true);
    expect(links.fix?.review?.pushedAt).toBeUndefined();
  });

  it('ход правок кончился вопросом — push не предлагается (Д8)', () => {
    const { review, links } = stand();
    links.fix = reviewLink({
      stage: 'fix',
      review: { url: URL, branch: 'feature/login', path: '/copy', findings: ['одно'] },
    });

    const event = review.finished({
      chatId: 'fix',
      aliases: ['fix'],
      link: links.fix as ChatLink,
      ok: true,
      text: 'Какой вариант выбрать?',
      paused: true,
    });

    expect(event).toBeUndefined();
    expect(links.fix?.review?.pushOffer).toBeUndefined();
  });

  it('правки не изменили копию — push не предлагается, лента говорит почему (Д8)', () => {
    const { review, links } = stand();
    links.fix = reviewLink({
      stage: 'fix',
      review: { url: URL, branch: 'feature/login', path: '/copy', findings: ['одно'] },
    });

    const event = review.finished({
      chatId: 'fix',
      aliases: ['fix'],
      link: links.fix as ChatLink,
      ok: true,
      text: 'Всё уже было поправлено.',
      hasWork: () => false,
    });

    expect(event).toMatchObject({ noChanges: true });
    expect(links.fix?.review?.pushOffer).toBeUndefined();
  });

  it('ветка MR неизвестна — push не предлагается, причина в связи и в виде (Д9)', () => {
    const { review, links } = stand();
    links.fix = reviewLink({
      stage: 'fix',
      review: { url: URL, path: '/copy', findings: ['одно'] },
    });

    const event = review.finished({
      chatId: 'fix',
      aliases: ['fix'],
      link: links.fix as ChatLink,
      ok: true,
      text: 'Поправил.',
      hasWork: () => true,
    });

    expect(event).toMatchObject({ pushBlocked: 'branch-unknown' });
    expect(links.fix?.review?.pushOffer).toBeUndefined();
    expect(review.view(links.fix as ChatLink)?.pushBlocked).toBe('branch-unknown');
  });

  it('без предложения (правок не было) отправлять нечего', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink({ review: { url: URL, path: '/copy', findings: ['одно'] } });

    expect(review.push({ chatId: 'c1' }).applied).toEqual([]);
    expect(started).toEqual([]);
  });
});

/**
 * Ревью у чужого CLI (Т6). Домен про провайдеров не знает вовсе — вся разница
 * приходит одним ответом запуска: разговору выдало ключ его собственное
 * хранилище, и связь обязана переехать на него.
 */
describe('звено у чужого CLI', () => {
  it('правки переезжают на настоящий ключ, временный в дереве не остаётся', async () => {
    const { review, links, started } = stand({ realKey: 'codex:fix1' });
    links.c1 = reviewLink({ review: { url: URL, path: '/copy', findings: ['одно'] } });

    const outcome = await review.decide({ chatId: 'c1', decision: 'fix' });

    const requested = started[0]?.chatId as string;
    expect(requested.startsWith('new-')).toBe(true);
    // Ответ панели и телефону называет тот ключ, под которым разговор есть.
    expect(outcome.applied[0]?.fixChatId).toBe('codex:fix1');
    expect(links['codex:fix1']?.stage).toBe('fix');
    expect(links['codex:fix1']?.review?.url).toBe(URL);
    expect(links[requested]).toBeUndefined();
  });

  it('отправка в MR продолжает тот же разговор чужого CLI', () => {
    const { review, links, started } = stand({ realKey: 'codex:fix1' });
    links['codex:fix1'] = reviewLink({
      stage: 'fix',
      review: {
        url: URL,
        branch: 'feature/login',
        path: '/copy',
        findings: ['одно'],
        pushOffer: true,
      },
    });

    const outcome = review.push({ chatId: 'codex:fix1' });

    expect(started[0]?.resume).toBe('codex:fix1');
    expect(outcome.applied[0]?.pushChatId).toBe('codex:fix1');
    expect(Object.keys(links)).toEqual(['codex:fix1']);
  });

  it('запуск не удался — ключа в ответе нет, и в дереве не появляется чужой', async () => {
    const { review, links } = stand({ started: false });
    links.c1 = reviewLink({ review: { url: URL, path: '/copy', findings: ['одно'] } });

    const outcome = await review.decide({ chatId: 'c1', decision: 'fix' });

    // Решение принято (переспрашивать человека не за что), а чата правок нет.
    expect(outcome.applied[0]?.decision).toBe('fix');
    expect(outcome.applied[0]?.fixChatId).toBeUndefined();
    expect(Object.keys(links).some((key) => key.startsWith('codex:'))).toBe(false);
  });
});

describe('ревью без блока итога (Д4)', () => {
  it('нет блока — панель сама просит ту же сессию выдать итог, человека не зовёт (A0)', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink();

    const event = review.finished({
      chatId: 'c1',
      aliases: ['c1'],
      link: links.c1 as ChatLink,
      ok: true,
      text: 'Посмотрел, в целом нормально.',
    });

    expect(event).toBeUndefined();
    expect(started).toHaveLength(1);
    expect(started[0]?.resume).toBe('c1');
    expect(started[0]?.stage).toBe('review');
    expect(started[0]?.prompt).toContain('agentdeck:review');
    expect(links.c1?.review?.followUp).toBe(true);
    expect(links.c1?.review?.missingAsked).toBeDefined();
    expect(links.c1?.review?.missing).toBeUndefined();
    expect(links.c1?.review?.findings).toBeUndefined();
  });

  it('блока нет и после просьбы — это не «замечаний нет»: группа ждёт, карточка предлагает повтор', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink({
      review: {
        url: URL,
        branch: 'feature/login',
        path: '/copy',
        missingAsked: '2026-09-09T11:00:00.000Z',
        followUp: true,
      },
    });

    const event = review.finished({
      chatId: 'c1',
      aliases: ['c1'],
      link: links.c1 as ChatLink,
      ok: true,
      text: 'Посмотрел, в целом нормально.',
    });

    expect(started).toEqual([]);
    expect(links.c1?.review?.followUp).toBeUndefined();
    expect(event).toMatchObject({ kind: 'review', missing: true, findings: [] });
    expect(links.c1?.review?.missing).toBe(true);
    expect(links.c1?.review?.decidedAt).toBeUndefined();
    expect(review.view(links.c1 as ChatLink)?.missing).toBe(true);
    expect(reviewNoticeText(event as never)).not.toContain('замечаний нет');
  });

  it('ход с вопросом человеку — ещё не итог: ни замечаний, ни «нет блока»', () => {
    const { review, links } = stand();
    links.c1 = reviewLink();

    const event = review.finished({
      chatId: 'c1',
      aliases: ['c1'],
      link: links.c1 as ChatLink,
      ok: true,
      text: 'Смотреть только бэкенд или фронт тоже?',
      paused: true,
    });

    expect(event).toBeUndefined();
    expect(links.c1?.review?.missing).toBeUndefined();
  });

  it('повтор идёт в ТУ ЖЕ сессию ревью, а следующий блок читается', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink({
      review: { url: URL, branch: 'feature/login', path: '/copy', missing: true },
    });

    const outcome = review.retryReview({ chatId: 'c1' });

    expect(started).toHaveLength(1);
    expect(started[0]?.resume).toBe('c1');
    expect(started[0]?.stage).toBe('review');
    expect(started[0]?.prompt).toContain('agentdeck:review');
    expect(outcome.applied[0]?.retryChatId).toBe('c1');
    expect(links.c1?.review?.missing).toBeUndefined();

    const event = review.finished({
      chatId: 'c1',
      aliases: ['c1'],
      link: links.c1 as ChatLink,
      ok: true,
      text: answer(['src/a.ts:1 — ошибка']),
    });
    expect(event).toMatchObject({ findings: ['src/a.ts:1 — ошибка'] });
  });

  /**
   * G3 (12.10.2026): продолжение сессии ревью несёт вводную на случай, когда
   * её файла на диске уже нет. Раньше там была общая строка «восстанови по git»,
   * и новая сессия получала «опубликуй ревью» или «выдай итог», не зная, какой
   * MR и что в нём проверять.
   */
  it('сессия ревью потеряна — новая получает исходное задание ревью, а не голую просьбу (G3)', async () => {
    const TASK = 'Проверь MR 42: валидация формы входа';
    const { review, links, started } = stand({ publishInSession: true });

    links.c1 = reviewLink({ task: TASK });
    review.finished({
      chatId: 'c1',
      aliases: ['c1'],
      link: links.c1 as ChatLink,
      ok: true,
      text: 'Посмотрел, в целом нормально.',
    });
    links.c2 = reviewLink({
      task: TASK,
      review: { url: URL, branch: 'feature/login', path: '/copy', missing: true },
    });
    review.retryReview({ chatId: 'c2' });
    links.c3 = reviewLink({
      task: TASK,
      review: { url: URL, branch: 'feature/login', path: '/copy', findings: ['одно'] },
    });
    await review.decide({ chatId: 'c3', decision: 'post' });
    links.c4 = reviewLink({
      stage: 'fix',
      task: TASK,
      review: {
        url: URL,
        branch: 'feature/login',
        path: '/copy',
        findings: ['одно'],
        pushOffer: true,
      },
    });
    review.push({ chatId: 'c4' });

    expect(started.map((run) => run.chatId)).toEqual(['c1', 'c2', 'c3', 'c4']);
    for (const run of started) {
      expect(run.fresh).toContain('transcript is gone');
      expect(run.fresh).toContain(TASK);
    }
  });

  it('повтор без отметки «нет блока» не запускается', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink();

    expect(review.retryReview({ chatId: 'c1' }).applied).toEqual([]);
    expect(started).toEqual([]);
  });

  it('сессия не продолжилась — дыра сразу на карточку, а не тихое ожидание', () => {
    const { review, links } = stand({ started: false });
    links.c1 = reviewLink();

    const event = review.finished({
      chatId: 'c1',
      aliases: ['c1'],
      link: links.c1 as ChatLink,
      ok: true,
      text: 'Посмотрел, в целом нормально.',
    });

    expect(event).toMatchObject({ kind: 'review', missing: true });
    expect(links.c1?.review?.followUp).toBeUndefined();
  });
});

/** Задание группы, с которым ревью стартовало: свидетель получает его же. */
const TASK = 'Проверь MR !42: вход по SSO и сброс сессии.';

function finishReview(
  review: SplitReview,
  links: Record<string, ChatLink>,
  key: string,
  text: string,
): ReturnType<SplitReview['finished']> {
  return review.finished({
    chatId: key,
    aliases: [key],
    link: links[key] as ChatLink,
    ok: true,
    text,
  });
}

describe('глубина ревью судится панелью (U4)', () => {
  it('отчёта о глубине нет — та же сессия один раз дочитывает, замечания не пишутся', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink();

    const event = finishReview(review, links, 'c1', answer([], null));

    expect(event).toBeUndefined();
    expect(started).toHaveLength(1);
    expect(started[0]?.resume).toBe('c1');
    expect(started[0]?.prompt).toContain('no "depth" report');
    expect(links.c1?.review?.findings).toBeUndefined();
    expect(links.c1?.review?.depthAsked).toBeDefined();
    expect(links.c1?.review?.followUp).toBe(true);
  });

  it('T2 с одного входа — неполное, хотя покрытие названо полным', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink();

    finishReview(
      review,
      links,
      'c1',
      answer([], { tier: 'T2', entries: ['diff-first'], coverage: 'full', uncovered: [] }),
    );

    expect(started).toHaveLength(1);
    expect(started[0]?.prompt).toContain('fewer than two independent entry points');
    expect(started[0]?.prompt).not.toContain('coverage is partial');
  });

  it('и после просьбы неполное — на карточку как «неполное», а не «замечаний нет»', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink({
      review: {
        url: URL,
        path: '/copy',
        depthAsked: '2026-09-09T11:00:00.000Z',
        followUp: true,
      },
    });

    const event = finishReview(
      review,
      links,
      'c1',
      answer([], { tier: 'T1', entries: ['diff-first'], coverage: 'partial', uncovered: ['docs'] }),
    );

    expect(started).toEqual([]);
    expect(event).toMatchObject({ kind: 'review', findings: [], incomplete: ['partial'] });
    expect(links.c1?.review?.incomplete).toEqual(['partial']);
    expect(links.c1?.review?.tier).toBe('T1');
    expect(links.c1?.review?.followUp).toBeUndefined();
    expect(review.view(links.c1 as ChatLink)?.incomplete).toEqual(['partial']);
    expect(reviewNoticeText(event as never)).not.toContain('замечаний нет');
  });

  it('полный отчёт с замечаниями — карточка сразу, без дочитывания и свидетеля', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink({ task: TASK });

    const event = finishReview(
      review,
      links,
      'c1',
      answer(['src/a.ts:1 — ошибка'], {
        tier: 'T2',
        entries: ['diff-first', 'frame-first'],
        coverage: 'full',
        uncovered: [],
      }),
    );

    expect(started).toEqual([]);
    expect(event).toMatchObject({ findings: ['src/a.ts:1 — ошибка'] });
    expect(links.c1?.review?.tier).toBe('T2');
    expect(links.c1?.review?.incomplete).toBeUndefined();
  });
});

describe('след требований чужой схемы в ревью по ссылке (T21)', () => {
  /** Задание с блоком слов владельца — как собирает его панель: после преамбулы копии. */
  const OWNER_TASK = `The panel prepared this copy.

${OWNER_REQUEST_OPENER}

[owner message 1 of 1]

проверь все MR, глубоко

${TASK}`;
  const FULL_T1 = { tier: 'T1', entries: ['diff-first'], coverage: 'full', uncovered: [] };
  const sieves = (body: object): string =>
    ['```agentdeck:sieves', JSON.stringify(body), '```'].join('\n');
  const withTrace = (findings: string[], body: object): string =>
    [answer(findings, FULL_T1), sieves(body)].join('\n');
  const WRONG = { points: [{ id: 1, status: 'done', note: 'ok' }] };
  const RIGHT = {
    sieves: [{ id: 'owner-1', status: 'pass', evidence: 'src/a.ts:10 — проверено дифф-first' }],
  };

  it('блок не той схемы — одна просьба переписать в той же сессии, замечания пока не пишутся', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink({ task: OWNER_TASK });

    const event = finishReview(review, links, 'c1', withTrace(['a.ts:1 — x'], WRONG));

    expect(event).toBeUndefined();
    expect(started).toHaveLength(1);
    expect(started[0]?.resume).toBe('c1');
    expect(started[0]?.prompt).toContain('owner-N');
    expect(started[0]?.prompt).toContain('never "points"');
    expect(links.c1?.review?.traceAsked).toBeDefined();
    expect(links.c1?.review?.findings).toBeUndefined();
  });

  it('строки есть, но ни одна не разобрана (числовой id, статус done) — тоже чужая схема', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink({ task: OWNER_TASK });
    finishReview(
      review,
      links,
      'c1',
      withTrace([], { sieves: [{ id: 1, status: 'done', evidence: 'a long enough evidence' }] }),
    );
    expect(started).toHaveLength(1);
  });

  it('после просьбы схема всё ещё чужая — «trace» на карточке, группа не «чистая»', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink({
      task: OWNER_TASK,
      review: { url: URL, path: '/copy', traceAsked: '2026-09-09T11:00:00.000Z', followUp: true },
    });

    const event = finishReview(review, links, 'c1', withTrace([], WRONG));

    expect(started).toEqual([]);
    expect(event).toMatchObject({ kind: 'review', findings: [], incomplete: ['trace'] });
    expect(links.c1?.review?.incomplete).toEqual(['trace']);
  });

  it('блока следа нет вовсе — та же одна просьба, потом «trace» на карточке', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink({ task: OWNER_TASK });
    const asked = finishReview(review, links, 'c1', answer(['a.ts:1 — x'], FULL_T1));
    expect(asked).toBeUndefined();
    expect(started).toHaveLength(1);
    expect(started[0]?.prompt).toContain('missing');
    expect(links.c1?.review?.traceAsked).toBeDefined();

    const again = finishReview(review, links, 'c1', answer(['a.ts:1 — x'], FULL_T1));
    expect(started).toHaveLength(1);
    expect(again).toMatchObject({ kind: 'review', incomplete: ['trace'] });
  });

  it('читаемый блок owner-N — никаких просьб, итог принят', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink({ task: OWNER_TASK });
    const event = finishReview(review, links, 'c1', withTrace(['a.ts:1 — x'], RIGHT));
    expect(started).toEqual([]);
    expect(event).toMatchObject({ findings: ['a.ts:1 — x'] });
  });

  it('слов владельца в задании нет — чужая схема сит ничего не требует', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink({ task: TASK });
    finishReview(review, links, 'c1', withTrace(['a.ts:1 — x'], WRONG));
    expect(started).toEqual([]);
  });
});

describe('второй свидетель пустого ревью (U5)', () => {
  const FULL_T1 = { tier: 'T1', entries: ['diff-first'], coverage: 'full', uncovered: [] };

  it('пустое полное ревью при T1 — новая сессия с тем же заданием, группа ещё не закрыта', () => {
    const { review, links, started, events } = stand();
    links.c1 = reviewLink({ task: TASK, groupIndex: 2 });

    const event = finishReview(review, links, 'c1', answer([], FULL_T1));

    expect(event).toBeUndefined();
    expect(started).toHaveLength(1);
    expect(started[0]?.resume).toBeUndefined();
    expect(started[0]?.cwd).toBe('/copies/feature-login');
    expect(started[0]?.prompt).toContain(TASK);
    const witnessKey = started[0]?.chatId as string;
    expect(witnessKey).not.toBe('c1');
    expect(links[witnessKey]?.groupIndex).toBe(2);
    expect(links[witnessKey]?.review?.witness).toBe(true);
    expect(links[witnessKey]?.review?.findings).toBeUndefined();
    expect(links.c1?.review).toMatchObject({
      findings: [],
      decision: 'none',
      followUp: true,
      witnessChatId: witnessKey,
    });
    expect(events).toEqual([]);
  });

  it('итог свидетеля решает группу, исходное ревью перестаёт ждать, второго свидетеля нет', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink({ task: TASK });
    finishReview(review, links, 'c1', answer([], FULL_T1));
    const witnessKey = started[0]?.chatId as string;

    const event = finishReview(review, links, witnessKey, answer(['src/b.ts:4 — гонка'], FULL_T1));

    expect(started).toHaveLength(1);
    expect(event).toMatchObject({ chatId: witnessKey, findings: ['src/b.ts:4 — гонка'] });
    expect(review.view(links[witnessKey] as ChatLink)?.witness).toBe(true);
    expect(links.c1?.review?.followUp).toBeUndefined();
  });

  it('пустой итог свидетеля закрывает группу и свидетеля не плодит', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink({ task: TASK });
    finishReview(review, links, 'c1', answer([], FULL_T1));
    const witnessKey = started[0]?.chatId as string;

    const event = finishReview(review, links, witnessKey, answer([], FULL_T1));

    expect(started).toHaveLength(1);
    expect(event).toMatchObject({ findings: [], decided: true });
    expect(links.c1?.review?.followUp).toBeUndefined();
  });

  it('свидетель на настоящем ключе чужого CLI — связь переезжает, исходное знает новый ключ', () => {
    const { review, links, started } = stand({ realKey: 'real-witness' });
    links.c1 = reviewLink({ task: TASK });

    finishReview(review, links, 'c1', answer([], FULL_T1));

    expect(started).toHaveLength(1);
    expect(links['real-witness']?.review?.witness).toBe(true);
    expect(links[started[0]?.chatId as string]).toBeUndefined();
    expect(links.c1?.review?.witnessChatId).toBe('real-witness');
  });

  it('T0 свидетеля не зовёт: взгляд и есть вся глубина', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink({ task: TASK });

    const event = finishReview(review, links, 'c1', answer([]));

    expect(started).toEqual([]);
    expect(event).toMatchObject({ decided: true });
  });

  it('без задания в связи свидетеля нет — группа закрывается, как раньше', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink();

    const event = finishReview(review, links, 'c1', answer([], FULL_T1));

    expect(started).toEqual([]);
    expect(event).toMatchObject({ decided: true });
    expect(links.c1?.review?.followUp).toBeUndefined();
  });

  it('запуск свидетеля отказан — временной связи не остаётся, группа закрывается', () => {
    const { review, links, started } = stand({ started: false });
    links.c1 = reviewLink({ task: TASK });

    const event = finishReview(review, links, 'c1', answer([], FULL_T1));

    expect(started).toHaveLength(1);
    expect(Object.keys(links)).toEqual(['c1']);
    expect(event).toMatchObject({ decided: true });
  });
});

/**
 * Публикует сессия ревью (владелец, 12.10.2026): сводный комментарий панели
 * одним списком терял строки, доказательства и сверку с открытыми тредами, а
 * разрешение на публикацию, данное в самом задании, панель не слышала.
 */
describe('публикация сессией ревью', () => {
  const card = '🟡 F-01 **Забыт await** — Где: src/a.ts:10-12';
  const pending = (review: Partial<NonNullable<ChatLink['review']>> = {}): ChatLink =>
    reviewLink({
      review: { url: URL, branch: 'feature/login', path: '/copy', findings: [card], ...review },
    });

  it('«отписать» продолжает сессию ревью заданием публикации; панель сама в MR не пишет', async () => {
    const { review, links, started, posted } = stand({ publishInSession: true });
    links.c1 = pending();

    const outcome = await review.decide({ chatId: 'c1', decision: 'post' });

    expect(posted).toEqual([]);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ chatId: 'c1', stage: 'review', resume: 'c1', cwd: '/copy' });
    expect(started[0]?.prompt).toContain(URL);
    expect(started[0]?.prompt).toContain('consent');
    expect(outcome.applied[0]?.posted).toBe(true);
    expect(links.c1?.review?.postedAt).toBe('2026-09-09T12:00:00.000Z');
  });

  it('«и то и другое» — публикация сессией и правки отдельным чатом', async () => {
    const { review, links, started } = stand({ publishInSession: true });
    links.c1 = pending();

    await review.decide({ chatId: 'c1', decision: 'both' });

    expect(started.map((run) => run.stage)).toEqual(['review', 'fix']);
    expect(started[0]?.resume).toBe('c1');
  });

  it('сессия занята — отказ с причиной, отметки записи нет, повтор доступен', async () => {
    const { review, links, posted } = stand({ publishInSession: true, busy: true });
    links.c1 = pending();

    const outcome = await review.decide({ chatId: 'c1', decision: 'post' });

    expect(posted).toEqual([]);
    expect(outcome.applied[0]?.postError).toMatch(/занята/);
    expect(links.c1?.review?.postedAt).toBeUndefined();
    // Повтор записи не перерешивает: причина есть, записи нет — клик снова работает.
    const again = await review.decide({ chatId: 'c1', decision: 'post' });
    expect(again.applied).toHaveLength(1);
  });

  it('без ключа сессии — отказ с причиной, а не тихий откат к сводному комментарию', async () => {
    const { review, links, posted, started } = stand({ publishInSession: true });
    links['new-1'] = pending();

    const outcome = await review.decide({ chatId: 'new-1', decision: 'post' });

    expect(posted).toEqual([]);
    expect(started).toEqual([]);
    expect(outcome.applied[0]?.postError).toMatch(/сессия ревью/);
  });

  it('разрешение в задании: сессия уже опубликовала — отметка ставится по итогу ревью', () => {
    const { review, links, started, posted } = stand({ publishInSession: true });
    links.c1 = reviewLink({
      review: { url: URL, branch: 'feature/login', path: '/copy', publish: true },
    });

    review.finished({
      chatId: 'c1',
      aliases: ['c1'],
      link: links.c1 as ChatLink,
      ok: true,
      text: answer([card]),
    });

    expect(links.c1?.review?.postedAt).toBe('2026-09-09T12:00:00.000Z');
    expect(started).toEqual([]);
    expect(posted).toEqual([]);
  });

  it('уже опубликованное повторно не пишется: клик «и то и другое» заводит только правки', async () => {
    const { review, links, started, posted } = stand({ publishInSession: true });
    links.c1 = pending({ publish: true, postedAt: '2026-09-09T11:00:00.000Z' });

    const outcome = await review.decide({ chatId: 'c1', decision: 'both' });

    expect(posted).toEqual([]);
    expect(started.map((run) => run.stage)).toEqual(['fix']);
    expect(outcome.applied[0]?.posted).toBe(true);
  });

  it('без разрешения в задании итог ревью ничего не отмечает записанным', () => {
    const { review, links } = stand({ publishInSession: true });
    links.c1 = reviewLink();

    review.finished({
      chatId: 'c1',
      aliases: ['c1'],
      link: links.c1 as ChatLink,
      ok: true,
      text: answer([card]),
    });

    expect(links.c1?.review?.postedAt).toBeUndefined();
  });

  it('публикует сессия — токен форджа панели кнопку не прячет', () => {
    const { review, links } = stand({ publishInSession: true, blocked: 'токен не сохранён' });
    links.c1 = pending();

    expect(review.view(links.c1 as ChatLink)?.postBlocked).toBeUndefined();
  });
});

describe('решение закрывает группу (Д3)', () => {
  it('«ничего» и «отписать» закрывают группу, «исправить» — нет: правки ещё идут', async () => {
    const { review, links, closed } = stand();
    for (const key of ['a', 'b', 'c']) {
      links[key] = reviewLink({
        title: key,
        review: { url: `${URL}${key}`, path: `/${key}`, findings: ['x'] },
      });
    }

    await review.decide({ chatId: 'a', decision: 'none' });
    await review.decide({ chatId: 'b', decision: 'post' });
    await review.decide({ chatId: 'c', decision: 'fix' });

    expect(closed.map((link) => link.title)).toEqual(['a', 'b']);
  });
});

describe('ключ разговора (Д11)', () => {
  it('связи одного разговора с РАЗНЫМ содержимым — всё равно один разговор', async () => {
    const { review, links, started } = stand();
    const base = reviewLink({
      conversation: 'conv-1',
      review: { url: URL, path: '/copy', findings: ['x'] },
    });
    links['new-1'] = base;
    // Под вторым ключом поле разошлось — раньше это раздваивало дерево.
    links['sess-1'] = { ...base, reviewedAt: '2026-09-09T11:00:00.000Z' };

    await review.decide({ chatId: 'new-1', decision: 'none', applyToAll: true });

    expect(started).toEqual([]);
    expect(links['new-1']?.review?.decision).toBe('none');
    expect(links['sess-1']?.review?.decision).toBe('none');
  });
});

describe('событие ревью словами', () => {
  it('замечания без решения зовут человека и называют их число', () => {
    const text = reviewNoticeText({ kind: 'review', chatId: 'c1', url: URL, findings: ['a', 'b'] });

    expect(text).toContain(URL);
    expect(text).toContain('2');
    expect(text).toContain('решение за вами');
  });

  it('пустой список говорит о закрытой группе, а не о молчании', () => {
    const text = reviewNoticeText({
      kind: 'review',
      chatId: 'c1',
      url: URL,
      findings: [],
      decided: true,
    });

    expect(text).toContain('замечаний нет');
  });

  it('принятое решение называет обе половины и отказ форджа', () => {
    const text = reviewNoticeText({
      kind: 'review',
      chatId: 'c1',
      url: URL,
      findings: ['одно'],
      decision: 'both',
      postError: 'токен форджа не сохранён',
    });

    expect(text).toContain('заведены правки');
    expect(text).toContain('замечания в MR не записаны');
    expect(text).not.toContain('публикуются');
    expect(text).toContain('токен форджа не сохранён');
  });

  it('предложение отправить правки говорит о кнопке, а не об отправке', () => {
    const text = reviewNoticeText({
      kind: 'review',
      chatId: 'c1',
      url: URL,
      findings: [],
      pushOffer: true,
    });

    expect(text).toContain('кнопкой');
    expect(text).not.toContain('отправлены');
  });
});

describe('сводный комментарий', () => {
  it('это только замечания и их число — ни подписи, ни рассказа о панели', () => {
    const body = reviewSummaryComment(['первое', 'второе']);

    expect(body).toBe('**Замечания ревью (2)**\n\n1. первое\n2. второе');
  });
});
