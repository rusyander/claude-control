import { describe, it, expect } from 'vitest';
import { SplitReview, reviewSummaryComment, type SplitReviewDeps } from './split-review.ts';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';

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
function stand(options: { post?: SplitReviewDeps['post']; blocked?: string } = {}) {
  const links: Record<string, ChatLink> = {};
  const started: { chatId: string; prompt: string; cwd: string; stage: string }[] = [];
  const posted: { url: string; body: string }[] = [];
  const events: { parent: string; event: unknown }[] = [];

  const review = new SplitReview({
    store: {
      all: () => links,
      set: (chatId, link) => void (links[chatId] = link),
    },
    post:
      options.post ??
      (async (url, body) => {
        posted.push({ url, body });
      }),
    ...(options.blocked ? { postBlocked: () => options.blocked } : {}),
    start: (input) => {
      started.push({
        chatId: input.chatId,
        prompt: input.prompt,
        cwd: input.cwd,
        stage: input.stage,
      });
      return true;
    },
    emit: (parent, event) => {
      events.push({ parent, event });
      return true;
    },
    log: () => {},
    now: () => new Date('2026-09-09T12:00:00.000Z'),
  });

  return { review, links, started, posted, events };
}

/** Ответ ревьюера в том виде, в каком его печатает модель. */
function answer(findings: string[]): string {
  return ['Посмотрел дифф.', '```agentdeck:review', JSON.stringify({ findings }), '```'].join(
    '\n',
  );
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
    expect(started[0]?.prompt).toContain('явное согласие');
    expect(started[0]?.prompt).toContain('feature/login');
    expect(outcome.applied[0]?.pushChatId).toBe(started[0]?.chatId);
    expect(links.fix?.review?.pushedAt).toBe('2026-09-09T12:00:00.000Z');
    expect(links.fix?.review?.pushOffer).toBe(false);
  });

  it('второй клик ничего не отправляет', () => {
    const { review, links, started } = stand();
    links.fix = reviewLink({
      stage: 'fix',
      review: { url: URL, path: '/copy', findings: ['одно'], pushOffer: true },
    });

    review.push({ chatId: 'fix' });
    const second = review.push({ chatId: 'fix' });

    expect(started).toHaveLength(1);
    expect(second.applied).toEqual([]);
  });

  it('без предложения (правок не было) отправлять нечего', () => {
    const { review, links, started } = stand();
    links.c1 = reviewLink({ review: { url: URL, path: '/copy', findings: ['одно'] } });

    expect(review.push({ chatId: 'c1' }).applied).toEqual([]);
    expect(started).toEqual([]);
  });
});

describe('сводный комментарий', () => {
  it('это только замечания и их число — ни подписи, ни рассказа о панели', () => {
    const body = reviewSummaryComment(['первое', 'второе']);

    expect(body).toBe('**Замечания ревью (2)**\n\n1. первое\n2. второе');
  });
});
