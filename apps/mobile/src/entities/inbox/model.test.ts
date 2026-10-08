import { describe, expect, it } from 'vitest';
import type { InboxChat } from '@agentdeck/contracts/chat-inbox';
import { homeEn } from '../../shared/config/i18n/home/en';
import { homeRu } from '../../shared/config/i18n/home/ru';
import { projectGroups } from './model';
import { toolSummary } from './toolSummary';
import { sentKeys } from './sentKeys';
import { visibleAsks } from './visibleAsks';
import { stableChatKey } from './stableChatKey';
import { pendingCount } from './pendingCount';
import { staleSent } from './staleSent';
import { questionCards } from './questionCards';
import { askKinds } from './askKinds';

/**
 * Главный экран телефона: чаты по проектам и вопросы по чатам. Проверяем то,
 * что человек видит первым: кто наверху, где какой чат и сколько ждёт ответа.
 */

const chat = (over: Partial<InboxChat> & Pick<InboxChat, 'id'>): InboxChat => ({
  title: over.id,
  project: 'shop',
  projectPath: 'C:/work/shop',
  isSandbox: false,
  status: 'idle',
  running: false,
  updatedAt: '2026-09-27T10:00:00.000Z',
  asks: [],
  ...over,
});
const ask = (key: string, askedAt: string) => ({
  kind: 'permission' as const,
  key,
  toolUseId: key,
  toolName: 'Bash',
  input: {},
  askedAt,
});

describe('projectGroups — чаты по проектам', () => {
  const chats = [
    chat({ id: 'shop-idle', updatedAt: '2026-09-27T11:00:00.000Z' }),
    chat({
      id: 'docs-run',
      project: 'docs',
      projectPath: 'C:/work/docs',
      status: 'running',
      running: true,
    }),
    chat({
      id: 'shop-wait',
      status: 'waiting',
      updatedAt: '2026-09-27T09:00:00.000Z',
      asks: [ask('p:1', '2026-09-27T09:00:00.000Z')],
    }),
    chat({ id: 'copy', projectPath: 'C:/work/shop-worktrees/x', homeProjectPath: 'C:/work/shop' }),
    chat({ id: 'sb', project: 'sandbox', projectPath: 'C:/u/sandbox/1', isSandbox: true }),
  ];

  it('проект с ждущим чатом — первым, за ним проект, где идёт работа', () => {
    expect(projectGroups(chats).map((group) => group.key)).toEqual([
      'c:/work/shop',
      'c:/work/docs',
      'sandbox',
    ]);
  });

  it('внутри проекта: ждущий, потом свежий; чат git-копии — под основной копией', () => {
    const shop = projectGroups(chats)[0];
    expect(shop?.chats.map((item) => item.id)).toEqual(['shop-wait', 'shop-idle', 'copy']);
    expect(shop).toMatchObject({ waiting: 1, running: 0, updatedAt: '2026-09-27T11:00:00.000Z' });
  });

  it('пусто — пусто', () => {
    expect(projectGroups([])).toEqual([]);
  });
});

describe('одно состояние на чат и значок по сути', () => {
  it('ждущий и при этом работающий чат считается один раз — ждущим', () => {
    const [group] = projectGroups([
      chat({
        id: 'a',
        status: 'waiting',
        running: true,
        asks: [ask('k1', '2026-09-27T10:00:00.000Z')],
      }),
      chat({ id: 'b', status: 'running', running: true }),
    ]);
    expect([group?.waiting, group?.running]).toEqual([1, 1]);
    expect(homeRu.groupCounts(group?.waiting ?? 0, group?.running ?? 0)).toBe(
      'ждут: 1 · работают: 1',
    );
    const [single] = projectGroups([
      chat({
        id: 'a',
        status: 'waiting',
        running: true,
        asks: [ask('k1', '2026-09-27T10:00:00.000Z')],
      }),
    ]);
    expect(homeRu.groupCounts(single?.waiting ?? 0, single?.running ?? 0)).toBe('ждут: 1');
  });

  it('значок различает вопросы и разрешения; первая правка — тоже разрешение', () => {
    const at = '2026-09-27T10:00:00.000Z';
    const question = {
      kind: 'question' as const,
      key: 'q',
      toolUseId: 'q',
      askedAt: at,
      questions: [],
    };
    const gate = { kind: 'branchGate' as const, key: 'g', toolUseId: 'g', askedAt: at };
    expect(askKinds([ask('p', at)])).toEqual({ questions: 0, permissions: 1 });
    expect(askKinds([question, gate, ask('p', at)])).toEqual({ questions: 1, permissions: 2 });
    expect(homeRu.asksBadge(0, 1)).toBe('1 разрешение');
    expect(homeRu.asksBadge(1, 2)).toBe('1 вопрос · 2 разрешения');
    expect(homeRu.asksBadge(5, 11)).toBe('5 вопросов · 11 разрешений');
    expect(homeRu.asksBadge(21, 22)).toBe('21 вопрос · 22 разрешения');
    expect(homeEn.asksBadge(0, 1)).toBe('1 permission');
    expect(homeEn.asksBadge(2, 1)).toBe('2 questions · 1 permission');
  });

  it('нижняя вкладка сохраняет имя, когда ждут ответа', () => {
    expect(homeRu.homeTabA11y(2)).toBe('Главная, ждут ответа: 2');
    expect(homeEn.homeTabA11y(2)).toBe('Home, 2 waiting for an answer');
  });
});

describe('questionCards — карточка на чат', () => {
  const a = chat({ id: 'a', asks: [ask('p:1', '2026-09-27T10:05:00.000Z')] });
  const b = chat({
    id: 'b',
    asks: [ask('p:2', '2026-09-27T10:01:00.000Z'), ask('p:3', '2026-09-27T10:02:00.000Z')],
  });
  const quiet = chat({ id: 'c' });

  it('все чаты с вопросами видны сразу; кто ждёт дольше — выше', () => {
    expect(questionCards([a, b, quiet], new Set()).map((card) => card.chat.id)).toEqual(['b', 'a']);
  });

  it('отправленное с телефона скрыто, пока сервер ещё его отдаёт; остальные на месте', () => {
    const sent = new Set([...sentKeys(b, { key: 'p:2' }), ...sentKeys(b, { key: 'p:3' })]);
    expect(questionCards([a, b], sent).map((card) => card.chat.id)).toEqual(['a']);
    expect(pendingCount([a, b], sent)).toBe(1);
    expect(visibleAsks(b, new Set(sentKeys(b, { key: 'p:2' }))).map((item) => item.key)).toEqual([
      'p:3',
    ]);
  });

  it('ключ отправленного — с чатом: одинаковый id вызова в другом чате не скрыт', () => {
    const other = chat({ id: 'z', asks: [ask('p:1', '2026-09-27T10:00:00.000Z')] });
    expect(pendingCount([a, other], new Set(sentKeys(a, { key: 'p:1' })))).toBe(1);
  });

  it('память об отправленном чистится, когда сервер вопрос больше не отдаёт', () => {
    const sent = new Set([...sentKeys(a, { key: 'p:1' }), ...sentKeys(b, { key: 'gone' })]);
    expect(staleSent([a, b], sent)).toEqual(sentKeys(b, { key: 'gone' }));
  });
});

describe('toolSummary — суть вызова одной строкой', () => {
  it('команда, файл, адрес — по старшинству', () => {
    expect(toolSummary({ command: 'git push', description: 'x' })).toBe('git push');
    expect(toolSummary({ file_path: 'C:/a.ts', content: '…' })).toBe('C:/a.ts');
    expect(toolSummary({ url: 'https://example.com' })).toBe('https://example.com');
  });

  it('ничего узнаваемого — пусто, а не JSON', () => {
    expect(toolSummary({ foo: 1 })).toBe('');
    expect(toolSummary(null)).toBe('');
  });
});

describe('ключи группы и отправленного устойчивы (F-151, F-190, F-153)', () => {
  it('POSIX-пути разного регистра — разные проекты; Windows-пути — один', () => {
    const posix = projectGroups([
      chat({ id: 'a', projectPath: '/srv/Repo', project: 'Repo' }),
      chat({ id: 'b', projectPath: '/srv/repo', project: 'repo' }),
    ]);
    expect(posix).toHaveLength(2);
    const windows = projectGroups([
      chat({ id: 'a', projectPath: 'C:/work/Shop' }),
      chat({ id: 'b', projectPath: 'c:\\work\\shop\\' }),
    ]);
    expect(windows).toHaveLength(1);
  });

  it('отправленное скрыто и после смены id чата с ключа прогона на id сессии (F-190)', () => {
    const asks = [ask('k', '2026-09-27T10:00:00.000Z')];
    const before = chat({ id: 'run-1', runKey: 'run-1', asks });
    const after = chat({ id: 'session-9', runKey: 'run-1', sessionId: 'session-9', asks });
    expect(visibleAsks(after, new Set(sentKeys(before, { key: 'k' })))).toEqual([]);
  });

  // D2: у вопроса из транскрипта ключ прогона появляется с ходом со стола и
  // пропадает с его концом — имя карточки и память об ответе не должны идти за ним.
  it('ход со стола начался и кончился — карточка та же, отвеченное не возвращается', () => {
    const asks = [ask('k', '2026-09-27T10:00:00.000Z')];
    const quiet = chat({ id: 's-1', sessionId: 's-1', asks });
    const deskTurn = chat({ id: 's-1', sessionId: 's-1', runKey: 'desk-7', asks });
    expect(stableChatKey(deskTurn)).toBe(stableChatKey(quiet));

    const answeredDuringTurn = new Set(sentKeys(deskTurn, { key: 'k' }));
    expect(visibleAsks(quiet, answeredDuringTurn)).toEqual([]);
    const phoneTurn = chat({ id: 's-1', sessionId: 's-1', runKey: 'phone-8', asks });
    expect(visibleAsks(phoneTurn, answeredDuringTurn)).toEqual([]);
    expect(staleSent([phoneTurn], answeredDuringTurn)).not.toContain(`s-1\u0000k`);
  });

  it('отправленное не держит строку чата в «ждёт»: счёт и состояние — по видимым', () => {
    const waiting = chat({
      id: 'w',
      runKey: 'w',
      status: 'waiting',
      running: true,
      asks: [ask('k', '2026-09-27T10:00:00.000Z')],
    });
    const sent = new Set(sentKeys(waiting, { key: 'k' }));
    const [group] = projectGroups([waiting], sent);
    expect(group?.waiting).toBe(0);
    expect(group?.running).toBe(1);
    expect(group?.chats[0]?.asks).toEqual([]);
    expect(group?.chats[0]?.status).toBe('running');
  });
});
