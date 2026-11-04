import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatSummary } from '@agentdeck/contracts';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import { i18n } from '@shared/config/i18n';
import { ChildStages } from '@features/ChatMessages';
import { collectChildStages } from './childStages';

/**
 * Хаб родителя целиком: настоящая сводка (`collectChildStages`) рисуется
 * настоящей карточкой `ChildStages`. Подменены только часы.
 *
 * Живой прогон 24.09.2026 (L23, L37, L20): строка остановленного звена писала
 * «в работе 21м», и человек читал это как «работает»; сводки «сколько идёт,
 * сколько ждёт меня» не было; чаты групп, отброшенных перезапуском, становились
 * строками групп. Вид конвейера разделения (план, разбор, очередь групп без
 * чата) снят вместе с конвейером (этап 10, G14): строки — только чаты детей.
 */

function chat(over: Partial<ChatSummary> & { id: string }): ChatSummary {
  return {
    title: over.id,
    project: 'probe',
    projectPath: 'C:/work/probe',
    isSandbox: false,
    messageCount: 1,
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:00.000Z',
    parentId: 'parent',
    ...over,
  };
}

const running = (id: string): ActiveRunView => ({ id, status: 'running' }) as ActiveRunView;

function render(chats: ChatSummary[], runs: ActiveRunView[]): string {
  const groups = collectChildStages(chats, 'parent', runs);
  // Кнопки строк ведут запрос сами — как в панели, под клиентом запросов.
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ChildStages groups={groups} onOpen={() => {}} sectionsOpen />
    </QueryClientProvider>,
  );
}

/** Текст без разметки — подписи проверяются так, как их читает человек. */
const textOf = (html: string): string => html.replace(/<[^>]+>/g, '|');

/** Кусок разметки от атрибута до конца его элемента-обёртки (грубо, но достаточно). */
function section(html: string, attr: string): string {
  const at = html.indexOf(attr);
  return at < 0 ? '' : html.slice(at, html.indexOf('</div>', at));
}

const triageChat = chat({
  id: 'triage',
  stage: 'triage',
  groupTitle: 'Разбор разделения',
  branch: 'agent/split',
  createdAt: '2026-09-24T10:00:00.000Z',
  updatedAt: '2026-09-24T10:21:57.000Z',
});

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('хаб — остановленное звено', () => {
  it('L23: время остановленного звена подписано как длительность, а не как «в работе»', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-24T12:00:00.000Z') });
    const html = render([triageChat], []);

    // Колонка «Время работы» (живой прогон 29.09): подпись над значением.
    expect(textOf(html)).toMatch(/Время работы\|*21м 57с/);
    expect(textOf(html)).not.toContain('в работе 21м');
  });
});

describe('хаб — сводка (L37)', () => {
  const chats = [
    triageChat,
    chat({
      id: 'busy',
      branch: 'fix/g1',
      stage: 'work',
      groupTitle: 'Группа 1',
      createdAt: '2026-09-24T10:30:00.000Z',
    }),
    chat({
      id: 'asking',
      branch: 'fix/g2',
      stage: 'work',
      groupTitle: 'Группа 2',
      awaitingReply: true,
    }),
    chat({ id: 'stuck', branch: 'fix/g5', stage: 'review', groupTitle: 'Группа 5' }),
  ];

  it('счётчики по состояниям, «ждёт вас» и время с начала', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-24T11:05:00.000Z') });
    const html = render(chats, [running('busy')]);
    const summary = textOf(section(html, 'data-hub-summary'));

    expect(summary).toContain('идёт: 1');
    expect(summary).toContain('ждёт вас: 1');
    expect(summary).toContain('стоит: 1');
    // С заведения первого звена до «сейчас»: прогон идёт.
    expect(summary).toContain('с начала 1ч 05м');
    // Строка разбора — не группа: три группы, а не четыре.
    expect(textOf(html)).toContain('Группы разделения: 3');
  });

  it('ждущих человека нет — «ждёт вас» не пишется вовсе', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-24T11:05:00.000Z') });
    const calm = chats.filter((item) => !item.awaitingReply);
    const markup = section(render(calm, []), 'data-hub-summary');
    const summary = textOf(markup);

    // Ни «ждёт вас: 0», ни «ждут вас: 0» — пустая корзина не пишется вовсе.
    expect(summary).not.toContain('вас');
    expect(markup).not.toContain('data-hub-count="ask"');
    expect(summary).toContain('стоят: 2');
  });
});

describe('хаб — отброшенные перезапуском (L20)', () => {
  it('чат с меткой `retired` — внизу под «Неактивно», не строка группы и не в счёте', () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-24T11:05:00.000Z') });
    const chats = [
      triageChat,
      // Старый чат отброшенной группы: ветка та же, что у живой группы.
      chat({
        id: 'old-g1',
        branch: 'fix/g1',
        stage: 'work',
        retired: true,
        title: 'Старая работа',
      }),
      chat({ id: 'busy', branch: 'fix/g1', stage: 'work', groupTitle: 'Группа 1' }),
    ];
    const html = render(chats, [running('busy')]);

    expect(textOf(html)).toContain('Группа разделения: 1');
    const inactive = html.slice(html.indexOf('data-hub-inactive'));
    expect(html.indexOf('data-hub-inactive')).toBeGreaterThan(-1);
    expect(textOf(inactive)).toContain('Неактивно: 1');
    expect(textOf(inactive)).toContain('Старая работа');
    // Строк групп с чатом ровно две — разбор и группа 1; отброшенный чат — не из них.
    expect(html.match(/data-hub-row="chat"/g)?.length).toBe(2);
  });

  // Живая приёмка 09.10 (п. 5): после нового разделения принятая группа уходила
  // в «Неактивно» без отметки — приёмку человека видно было только в списке чатов.
  it('снятый принятый чат несёт в «Неактивно» отметку «принято», прочие снятые — нет', () => {
    const chats = [
      triageChat,
      chat({
        id: 'old-ok',
        retired: true,
        accepted: true,
        copyLeft: true,
        title: 'Старая принятая',
      }),
      chat({ id: 'old-open', retired: true, title: 'Старая непринятая' }),
    ];
    const html = render(chats, []);

    const inactive = html.slice(html.indexOf('data-hub-inactive'));
    expect(inactive.match(/data-hub-accepted/g)?.length).toBe(1);
    const marker = inactive.indexOf('data-hub-accepted');
    expect(marker).toBeGreaterThan(inactive.indexOf('Старая принятая'));
    expect(marker).toBeLessThan(inactive.indexOf('Старая непринятая'));
    expect(textOf(inactive)).toContain('принято');
  });
});

/**
 * Живой прогон 29.09: строка группы одной строкой через «·» резалась
 * многоточием на полуслове, глубины не было вовсе, а на каком шаге группа —
 * только открыв её чат. Теперь колонки (модель с глубиной, до первой правки,
 * время работы) и «Шаг N из M» с именем шага из плана агента группы.
 */
describe('хаб разделения — колонки и шаг группы', () => {
  const work = chat({
    id: 'g0',
    stage: 'work',
    groupTitle: 'CP-admin-UI',
    branch: 'fix-PROJ-1409-PROJ-1334/cp-clients-instances-2',
    model: 'claude-opus-5-5',
    effort: 'high',
    firstEditAt: '2026-09-24T10:03:10.000Z',
    updatedAt: '2026-09-24T11:58:00.000Z',
  });

  function renderWith(progress: unknown): string {
    const client = new QueryClient();
    client.setQueryData(['chats', 'g0', 'progress'], progress);
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ChildStages groups={collectChildStages([work], 'parent', [])} onOpen={() => {}} />
      </QueryClientProvider>,
    );
  }

  it('модель идёт вместе с глубиной, время — отдельными колонками, ветка не режется', () => {
    const html = renderWith({ tasks: [], agents: [] });
    expect(section(html, 'data-hub-meta-cell="model"')).toContain('claude-opus-5-5 · Высокая');
    expect(textOf(html)).toMatch(/До первой правки\|*3м 10с/);
    expect(html).toContain('data-hub-meta-cell="workTime"');
    expect(textOf(html)).toContain('fix-PROJ-1409-PROJ-1334/cp-clients-instances-2');
    // Многоточие обрезало строку на полуслове — у строк группы его больше нет.
    expect(section(html, 'data-hub-meta')).not.toContain('truncate');
  });

  it('шаг по плану агента: «Шаг 8 из 14», имя шага и живые субагенты', () => {
    const tasks = [
      ...Array.from({ length: 7 }, (_, i) => ({ text: `s${i}`, status: 'completed' })),
      { text: 'Ревью', status: 'in_progress' },
      ...Array.from({ length: 6 }, (_, i) => ({ text: `p${i}`, status: 'pending' })),
    ];
    const agents = [
      { description: 'lane A', status: 'running' },
      { description: 'lane B', status: 'running' },
    ];
    const html = renderWith({ tasks, agents });
    expect(html).toContain('data-hub-step="8/14"');
    expect(textOf(html)).toContain('Шаг 8 из 14');
    expect(textOf(html)).toContain('Ревью · 2 агента');
  });

  // Решение владельца 29.09: группа без плана агента, навык проекта пишет
  // `.agent/steps.json` в копии — хаб показывает шаг из файла.
  it('файл шагов без плана агента: «Шаг 8 из 14» и название шага', () => {
    const html = renderWith({
      tasks: [],
      agents: [],
      steps: { current: 8, total: 14, title: 'Прогон тестов' },
    });
    expect(html).toContain('data-hub-step="8/14"');
    expect(textOf(html)).toContain('Шаг 8 из 14');
    expect(textOf(html)).toContain('Прогон тестов');
  });

  it('плана нет — строки шага нет', () => {
    expect(renderWith({ tasks: [], agents: [] })).not.toContain('data-hub-step');
  });
});

// Индикатор группы (19.10.2026): полоса «сделано из скольких» с процентом,
// состояние с его временем и чем группа занята прямо сейчас — одним взглядом
// на хаб, без захода в каждый чат.
describe('хаб разделения — индикатор группы', () => {
  const work = chat({
    id: 'g0',
    stage: 'work',
    groupTitle: 'CP-admin-UI',
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T11:58:00.000Z',
  });
  const steps = { current: 8, total: 14, title: 'Прогон тестов' };
  const bash = { name: 'Bash', summary: 'pnpm test', startedAt: '2026-09-24T11:57:00.000Z' };

  function renderWith(progress: unknown, runs: ActiveRunView[]): string {
    const client = new QueryClient();
    client.setQueryData(['chats', 'g0', 'progress'], progress);
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ChildStages groups={collectChildStages([work], 'parent', runs)} onOpen={() => {}} />
      </QueryClientProvider>,
    );
  }

  it('идёт: полоса 7 из 14 — 50 %, «работает» с начала хода, вызов и его длительность', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T12:00:00.000Z'));
    // Группа заведена в 10:00, идущий ход начался в 11:00 — время считается с хода.
    const turn = { ...running('g0'), startedAt: Date.parse('2026-09-24T11:00:00.000Z') };
    const html = renderWith({ tasks: [], agents: [], steps, activeTool: bash }, [turn]);
    expect(html).toContain('data-group-progress="working"');
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="50"/);
    expect(textOf(html)).toContain('работает · 1ч 00м');
    expect(textOf(html)).toContain('7 из 14 · 50 %');
    expect(textOf(html)).toContain('Bash: pnpm test · 3м 00с');
  });

  it('запрос прав: «ждёт разрешения» с момента вызова', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T12:00:00.000Z'));
    const waiting = {
      id: 'g0',
      status: 'waiting',
      permissions: [{ toolName: 'Bash', input: {}, toolUseId: 't1' }],
    } as ActiveRunView;
    const html = renderWith({ tasks: [], agents: [], steps, activeTool: bash }, [waiting]);
    expect(html).toContain('data-group-progress="permission"');
    expect(textOf(html)).toContain('ждёт разрешения · 3м 00с');
  });

  it('не идёт — «стоит» с последней записи, без вызова', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T12:00:00.000Z'));
    const html = renderWith({ tasks: [], agents: [], steps, activeTool: bash }, []);
    expect(html).toContain('data-group-progress="stalled"');
    expect(textOf(html)).toContain('стоит · 2м 00с');
    expect(textOf(html)).not.toContain('Bash: pnpm test');
  });
});
