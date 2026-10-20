import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SPLIT_DEFAULTS_BUILTIN } from '@agentdeck/contracts/split-groups';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import type { ChatEvent } from '../../../domains/chat/chat-events.ts';
import { writeSettings, writeToken } from '../../../domains/integrations/store/store.ts';
import { registerChatRunRoutes } from './run-routes.ts';
import { registerSplitControlRoutes } from '../split-control-routes.ts';

/**
 * Разрешения группы разделения поверх НАСТОЯЩЕГО маршрута прав и НАСТОЯЩЕГО
 * хранилища: запрос от прогона группы решается строками вкладки «Группы»
 * (общие + своё у проекта), а прогон обычного чата — по-прежнему тумблером.
 * Заглушен только процесс CLI — внешняя граница, которой у теста быть не может.
 */
describe('маршрут прав: строки вкладки «Группы»', () => {
  let root: string;
  let project: string;
  let copy: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let session: ChatSession;
  let events: ChatEvent[];
  const detaches: (() => void)[] = [];
  const GROUP = 'group-chat';
  const PLAIN = 'plain-chat';

  const liveRun = (): RunLike => ({
    start: () => new Promise(() => undefined),
    stop: () => undefined,
  });

  const startRun = (chatId: string): void => {
    registry.start(chatId, { prompt: 'задача группы', cwd: copy }, { projectPath: copy });
    detaches.push(
      registry.attach(chatId, 0, {
        send: ({ event }) => void events.push(event),
        close: () => undefined,
      }) as () => void,
    );
  };

  /**
   * Ответ маршрута или `'card'` — вызов придержан карточкой человеку. Ждать
   * ответа на придержанный запрос нельзя: он и не придёт до клика.
   */
  let asked = 0;
  const ask = async (chatId: string, command: string, toolName = 'Bash'): Promise<string> => {
    asked += 1;
    const toolUseId = `tool-${asked}`;
    const input = toolName === 'Bash' ? { command } : { file_path: command };
    const pending = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId: chatId, toolName, input, toolUseId },
    });
    const hasCard = (): boolean =>
      events.some(
        (event) =>
          event.kind === 'permission' && (event as { toolUseId?: string }).toolUseId === toolUseId,
      );
    // Ждём того, что случится: ответа маршрута или карточки. Маршрут перед
    // решением читает git копии, и фиксированное окно под нагрузкой путало
    // «ещё думает» с «придержан без карточки».
    const answered = pending.then((res) => res.json<{ behavior: string }>().behavior);
    const deadline = Date.now() + 10_000;
    let settled = 'pending';
    void answered.then((behavior) => (settled = behavior));
    while (settled === 'pending' && !hasCard() && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10));
    }
    if (settled !== 'pending') return settled;
    const card = hasCard();
    session.abort(chatId);
    await pending;
    return card ? 'card' : 'pending-without-card';
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-perms-'));
    project = join(root, 'repo');
    copy = join(root, 'repo-group');
    mkdirSync(project, { recursive: true });
    // Копия группы — настоящая копия git (worktree) проекта: свою ветку маршрут
    // читает у git, как у живой группы.
    const git = (cwd: string, args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });
    };
    git(project, ['init', '-q']);
    git(project, ['commit', '-q', '--allow-empty', '-m', 'init']);
    git(project, ['worktree', 'add', '-q', '-b', 'feature/a', copy]);
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    store.setSplitPlan({
      parentChatId: 'parent',
      projectPath: project,
      createdAt: new Date().toISOString(),
      order: [0],
      request: { allowEdits: true },
      proposal: { groups: [] },
      groups: [{ index: 0, branch: 'feature/a', status: 'running', chatId: GROUP }],
    } as unknown as SplitPlanRecord);
    store.setChatLink(GROUP, {
      parentChatId: 'parent',
      groupIndex: 0,
      branch: 'feature/a',
      createdAt: new Date().toISOString(),
    });
    events = [];
    registry = new ChatRunRegistry(liveRun);
    session = new ChatSession(registry);
    const ctx = {
      store,
      location: {
        paths: {
          root,
          settings: join(root, 'settings.json'),
          settingsLocal: join(root, 'settings.local.json'),
          appData: join(root, 'agentdeck'),
          mcpConfig: join(root, '.claude.json'),
        },
      },
      backupDir: join(root, 'backups'),
      pricing: { current: () => ({ entries: [] }) },
      models: { current: () => ({ models: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatRunRoutes(app, ctx, registry, session);
    // Маршрут «убрать отметки» — тот же, что зовёт хаб; конвейер ему не нужен.
    registerSplitControlRoutes(app, ctx, {} as Parameters<typeof registerSplitControlRoutes>[2]);
    await app.ready();
    startRun(GROUP);
    startRun(PLAIN);
  });

  afterEach(async () => {
    for (const detach of detaches.splice(0)) detach();
    registry.stopAll();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('группа из коробки коммитит и убирает сама, базу сносить — спрашивает', async () => {
    expect(await ask(GROUP, 'git commit -m "группа"')).toBe('allow');
    expect(await ask(GROUP, 'rm -rf dist')).toBe('allow');
    expect(await ask(GROUP, 'pnpm build')).toBe('allow');
    expect(await ask(GROUP, 'psql -c "drop table users"')).toBe('card');
  });

  it('запись в MR и трекер из коробки — сама с отметкой, слияние и удаление — карточка (политика 19.10)', async () => {
    // Политика владельца 19.10: карточка — только удаление, слияние, пуш в
    // основную ветку и принудительный пуш. Запись наружу идёт сама, но каждая
    // остаётся отметкой в хабе родителя — ответ в треде MR не пройдёт незаметно.
    expect(await ask(GROUP, '', 'mcp__gitlab__create_merge_request_note')).toBe('allow');
    expect(await ask(GROUP, '', 'mcp__gitlab__update_merge_request')).toBe('allow');
    expect(await ask(GROUP, '', 'mcp__atlassian__jira_transition_issue')).toBe('allow');
    const notices = store.getSplitPlan('parent')?.groups[0]?.autoNotices ?? [];
    expect(notices.map((notice) => notice.summary)).toEqual([
      'mcp__gitlab__create_merge_request_note',
      'mcp__gitlab__update_merge_request',
      'mcp__atlassian__jira_transition_issue',
    ]);
    expect(await ask(GROUP, '', 'mcp__gitlab__merge_merge_request')).toBe('card');
    expect(await ask(GROUP, '', 'mcp__gitlab__delete_branch')).toBe('card');
    expect(await ask(GROUP, '', 'mcp__atlassian__jira_delete_issue')).toBe('card');
    expect(await ask(GROUP, '', 'mcp__gitlab__get_merge_request')).toBe('allow');
    expect(await ask(GROUP, '', 'mcp__atlassian__jira_get_issue')).toBe('allow');
  });

  it('обычный чат без тумблера — как раньше: коммит карточкой', async () => {
    expect(await ask(PLAIN, 'git commit -m "чат"')).toBe('card');
  });

  it('строка проекта сильнее общей; общая действует там, где проект не трогал', async () => {
    store.setSplitSettings(project, { deliver: true, permissions: { gitWrite: false } });
    expect(await ask(GROUP, 'git commit -m "группа"')).toBe('card');

    store.setSplitDefaults({
      ...structuredClone(SPLIT_DEFAULTS_BUILTIN),
      permissions: { ...SPLIT_DEFAULTS_BUILTIN.permissions, filesDelete: false, routine: false },
    });
    expect(await ask(GROUP, 'rm -rf dist')).toBe('card');
    expect(await ask(GROUP, 'pnpm build')).toBe('card');

    store.setSplitSettings(project, { deliver: true, permissions: null });
    expect(await ask(GROUP, 'git commit -m "группа"')).toBe('allow');
  });

  it('связь без группы в записи разделения (звено каскада) — не группа', async () => {
    store.setChatLink(PLAIN, {
      parentChatId: 'parent',
      groupIndex: 5,
      branch: 'feature/other',
      createdAt: new Date().toISOString(),
    });
    expect(await ask(PLAIN, 'git commit -m "каскад"')).toBe('card');
  });

  it('разделение без права правок — группа правит файлы только с карточкой', async () => {
    expect(await ask(GROUP, 'a.txt', 'Edit')).toBe('allow');
    const plan = store.getSplitPlan('parent') as SplitPlanRecord;
    store.setSplitPlan({ ...plan, request: { allowEdits: false } });
    expect(await ask(GROUP, 'a.txt', 'Edit')).toBe('card');
  });

  it('тумблер, включённый человеком в чате группы, сильнее строк группы', async () => {
    store.setSplitSettings(project, { deliver: true, permissions: { gitWrite: false } });
    session.armAutoApprove(GROUP, { enabled: true, allowEdits: true });
    expect(await ask(GROUP, 'git commit -m "человек"')).toBe('allow');
  });

  /**
   * Итоговое ревью 25.09 (M3): группа наследует тумблер родителя, и раньше
   * любой унаследованный тумблер — даже выключенный — отключал строки группы:
   * коммит вставал на карточке, которую никто не смотрит, а при включённом у
   * родителя выключенные строки молча игнорировались.
   */
  it('унаследованный от родителя выключенный тумблер строкам не мешает', async () => {
    session.armAutoApprove('parent', { enabled: false, allowEdits: true });
    session.inherit(['parent'], GROUP, true);
    expect(await ask(GROUP, 'git commit -m "группа"')).toBe('allow');
  });

  it('унаследованный включённый тумблер не отменяет выключенную строку', async () => {
    store.setSplitSettings(project, { deliver: true, permissions: { gitWrite: false } });
    session.armAutoApprove('parent', { enabled: true, allowEdits: true });
    session.inherit(['parent'], GROUP, true);
    expect(await ask(GROUP, 'git commit -m "группа"')).toBe('card');
  });

  it('ответ человека из хаба (тумблер выключен) строки группы не отключает', async () => {
    session.armAutoApprove(GROUP, { enabled: false, allowEdits: true });
    expect(await ask(GROUP, 'git commit -m "после ответа"')).toBe('allow');
  });

  /**
   * Аудит 25.09, L163: пуш с перезаписью истории у группы — только карточкой,
   * кроме пуша арендой СВОЕЙ ветки после rebase (решение владельца): без него
   * группа, догнавшая основную ветку, вставала бы у самого MR.
   */
  it('затирание истории — карточка; аренда своей ветки — сама, чужой — карточка', async () => {
    expect(await ask(GROUP, 'git push --force origin feature/a')).toBe('card');
    expect(await ask(GROUP, 'git push --force-with-lease origin feature/a')).toBe('allow');
    expect(await ask(GROUP, 'git push --force-with-lease origin HEAD:feature/a')).toBe('allow');
    expect(await ask(GROUP, 'git push --force-with-lease origin main')).toBe('card');
    expect(
      await ask(GROUP, 'git push --force-with-lease origin feature/a && git push -f origin main'),
    ).toBe('card');
    // Пуш у человека — и аренда своей ветки тоже.
    store.setSplitSettings(project, { deliver: true, permissions: { gitWrite: 'human' } });
    expect(await ask(GROUP, 'git push --force-with-lease origin feature/a')).toBe('card');
  });

  /**
   * Просьба владельца 19.10: человека заваливало карточками на рутине группы.
   * Пример с карточки — составная команда в своей копии, ветка группы заведена
   * по правилу проекта (ключи через запятую), а не та, что в записи разделения.
   */
  const OWN = 'fix-GOR-1567,GOR-1589,GOR-1626/kb-models-upload-errors';
  const checkout = (branch: string): void => {
    execFileSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: copy });
  };
  const at = (): string => copy.replace(/\\/g, '/');
  const inCopy = (inner: string): string => `cd "${at()}" && ${inner} 2>&1 | tail -5`;

  it('рутина в своей копии — сама: пример с карточки владельца и составные команды', async () => {
    checkout(OWN);
    expect(
      await ask(
        GROUP,
        `cd "${at()}" && git push --force-with-lease origin "HEAD:${OWN}" 2>&1 | tail -5 # sieve-ack: @.agent/tmp/sieve-ack.txt`,
      ),
    ).toBe('allow');
    expect(await ask(GROUP, inCopy(`git push origin "HEAD:${OWN}"`))).toBe('allow');
    expect(await ask(GROUP, `git push --force-with-lease=${OWN} origin ${OWN}`)).toBe('allow');
    expect(await ask(GROUP, 'git push -u origin HEAD')).toBe('allow');
    // Слова сообщения коммита — не команда: «drop» и «rm -rf» в нём не база и не удаление.
    expect(await ask(GROUP, inCopy('git add -A && git commit -m "drop the rm -rf step"'))).toBe(
      'allow',
    );
    expect(await ask(GROUP, inCopy('git fetch origin && git rebase origin/main'))).toBe('allow');
    expect(await ask(GROUP, 'git stash push -m "wip" && git stash pop')).toBe('allow');
    expect(await ask(GROUP, 'rm -rf .agent/tmp/probe')).toBe('allow');
    // Политика 19.10: обычный пуш рабочей ветки — сам, и не только своей.
    expect(await ask(GROUP, inCopy('git push origin HEAD:feature/other'))).toBe('allow');
    expect(await ask(GROUP, `git -C "${at()}" push origin "HEAD:${OWN}"`)).toBe('allow');
    expect(await ask(GROUP, inCopy('rm -rf dist coverage && rm -f build.log'))).toBe('allow');
  });

  it('опасное в той же форме, что пример владельца, — карточка', async () => {
    checkout(OWN);
    const cards = [
      inCopy('git push origin HEAD:main'),
      'git push origin main',
      'git push origin master',
      inCopy('git push --force-with-lease origin HEAD:main'),
      inCopy(`git push --force origin "HEAD:${OWN}"`),
      inCopy(`git push -f origin "HEAD:${OWN}"`),
      `git -C "${at()}" push origin main`,
      `git -C "${at()}" push origin HEAD:main`,
      inCopy('git fetch && git push origin HEAD:develop'),
      inCopy(`git push --force-with-lease origin "HEAD:${OWN}" "HEAD:feature/other"`),
      inCopy('git merge origin/main'),
      inCopy('git branch -d feature/old'),
      inCopy('git push origin :feature/old'),
      inCopy('git stash drop'),
      inCopy('rm -rf src'),
      inCopy('rm -f notes.txt'),
      'psql -c "drop table users"',
      'gh pr merge 5 --squash',
      inCopy(`git push origin --delete "${OWN}"`),
      inCopy(`git push origin ":${OWN}"`),
      inCopy(`git push origin "+HEAD:${OWN}"`),
      inCopy(`git push upstream "HEAD:${OWN}"`),
      inCopy(`git push -o merge_request.merge_when_pipeline_succeeds origin "HEAD:${OWN}"`),
      inCopy(`git checkout main && git merge "${OWN}"`),
      inCopy('git reset --hard origin/main'),
      inCopy('git clean -fd'),
      inCopy(`git branch -D "${OWN}"`),
      inCopy('git tag -d v1'),
      'curl -X PUT -H "PRIVATE-TOKEN: x" https://git.example.com/api/v4/projects/1/merge_requests/5/merge',
      'gh api -X PUT repos/team/repo/pulls/5/merge',
      'psql -c "insert into users values (1)"',
      'psql -c "update users set name = 1"',
      inCopy('rm -rf ../repo'),
      // На Linux tmpdir — сам `/tmp`, а путь, записанный как `/tmp/…`, временный по
      // замыслу (paths.ts `TEMP_PREFIX`): по тексту копию в нём от мусора не отличить.
      ...(/^\/(var\/)?tmp\//.test(root) ? [] : [`rm -rf "${root.replace(/\\/g, '/')}/repo"`]),
    ];
    for (const command of cards)
      expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → card`);
    expect(await ask(GROUP, '', 'mcp__gitlab__merge_merge_request')).toBe('card');
  });

  it('своя ветка — та, что стоит в копии по git, а не названная в команде', async () => {
    // В записи разделения — feature/a, в копии — feature/b: своя — feature/b.
    checkout('feature/b');
    expect(await ask(GROUP, 'git push --force-with-lease origin HEAD:feature/a')).toBe('card');
    // Обычный пуш в другую рабочую ветку — перемотка вперёд, сам (политика 19.10).
    expect(await ask(GROUP, 'git push origin HEAD:feature/a')).toBe('allow');
    expect(await ask(GROUP, 'git push --force-with-lease origin HEAD:feature/b')).toBe('allow');
    // В копии основная ветка — пуш в неё и слияние в неё у человека, в какой форме ни будь.
    checkout('main');
    expect(await ask(GROUP, 'git push origin HEAD')).toBe('card');
    expect(await ask(GROUP, 'git push')).toBe('card');
    expect(await ask(GROUP, 'git merge feature/a')).toBe('card');
    // Пуш из чужого каталога — уже не своя копия.
    checkout('feature/a');
    expect(
      await ask(
        GROUP,
        `cd "${project.replace(/\\/g, '/')}" && git push --force-with-lease origin HEAD:feature/a`,
      ),
    ).toBe('card');
    expect(await ask(GROUP, `git -C "${project}" push origin HEAD:feature/a`)).toBe('card');
  });

  /**
   * Журнал 19.10 02:17:02 (L7.12): доставленная группа после пустого rebase
   * переписала арендой ветку MR, снятого с черновика и стоявшего на ревью.
   * Состояние MR знает только фордж — здесь это заглушка GitLab на свободном
   * порту, а маршрут прав и хранилище настоящие.
   */
  it('аренда своей ветки при MR на ревью — карточка; черновик — сама; фордж молчит — карточка', async () => {
    let draft = true;
    let reads = 0;
    const forge = createServer((req, res) => {
      if (!req.url?.includes('/merge_requests/5')) {
        res.writeHead(404).end('{}');
        return;
      }
      reads += 1;
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          iid: 5,
          title: 'Группа A',
          state: 'opened',
          draft,
          source_branch: 'feature/a',
          target_branch: 'main',
          web_url: mrUrl,
        }),
      );
    });
    await new Promise<void>((done) => forge.listen(0, '127.0.0.1', done));
    const site = `http://127.0.0.1:${(forge.address() as AddressInfo).port}`;
    const mrUrl = `${site}/team/repo/-/merge_requests/5`;
    try {
      const plan = store.getSplitPlan('parent') as SplitPlanRecord;
      store.setSplitPlan({
        ...plan,
        groups: plan.groups.map((group) => ({ ...group, mr: mrUrl })),
      } as SplitPlanRecord);
      const lease = 'git push --force-with-lease origin feature/a';

      // Ключа к форджу нет — состояние MR неизвестно, решает человек.
      expect(await ask(GROUP, lease)).toBe('card');
      expect(reads).toBe(0);

      writeSettings(store, 'gitlab', { enabled: true, baseUrl: site, repo: '' });
      writeToken(join(root, 'agentdeck'), 'gitlab', 'stub-key');
      expect(await ask(GROUP, lease)).toBe('allow');
      expect(reads).toBe(1);

      draft = false;
      expect(await ask(GROUP, lease)).toBe('card');
      expect(await ask(GROUP, 'git push --force-with-lease origin HEAD:feature/a')).toBe('card');
      // Обычный коммит фордж не спрашивает: сеть — только когда она решает исход.
      reads = 0;
      expect(await ask(GROUP, 'git commit -m "группа"')).toBe('allow');
      expect(reads).toBe(0);

      // Фордж не ответил — тоже карточка, а не молчаливое «можно».
      forge.closeAllConnections();
      await new Promise<void>((done) => forge.close(() => done()));
      draft = true;
      expect(await ask(GROUP, lease)).toBe('card');
    } finally {
      if (forge.listening) await new Promise<void>((done) => forge.close(() => done()));
    }
  });

  /** Аудит 25.09, L20: «с отметкой» — прошло само, но хаб родителя это видит. */
  it('строка «с отметкой» разрешает и пишет отметку, хаб её убирает', async () => {
    store.setSplitSettings(project, { deliver: true, permissions: { gitWrite: 'notify' } });
    expect(await ask(GROUP, 'git commit -m "группа"')).toBe('allow');
    expect(await ask(GROUP, 'pnpm build')).toBe('allow');
    const notices = (store.getSplitPlan('parent') as SplitPlanRecord).groups[0]?.autoNotices;
    expect(notices?.map((notice) => notice.summary)).toEqual(['git commit -m "группа"']);

    const dismissed = await app.inject({
      method: 'POST',
      url: '/api/chat/split/parent/auto-notices/dismiss',
      payload: { index: 0 },
    });
    expect(dismissed.json()).toEqual({ index: 0, dismissed: 1 });
    expect(
      (store.getSplitPlan('parent') as SplitPlanRecord).groups[0]?.autoNotices,
    ).toBeUndefined();

    const missing = await app.inject({
      method: 'POST',
      url: '/api/chat/split/parent/auto-notices/dismiss',
      payload: { index: 7 },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ messageCode: 'split-group-not-found' });
  });

  it('строка «человек» — карточка и без отметки', async () => {
    store.setSplitSettings(project, { deliver: true, permissions: { routine: 'human' } });
    expect(await ask(GROUP, 'pnpm build')).toBe('card');
    expect(
      (store.getSplitPlan('parent') as SplitPlanRecord).groups[0]?.autoNotices,
    ).toBeUndefined();
  });
});
