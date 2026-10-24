import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SPLIT_DEFAULTS_BUILTIN } from '@agentdeck/contracts/split-groups';
import { deferredIdOf, isPanelRefusal } from '@agentdeck/contracts/deferred-asks';
import { AppStore } from '../../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import type { ServerContext } from '../../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../../domains/chat/ChatSession/ChatSession.ts';
import type { ChatEvent } from '../../../domains/chat/chat-events.ts';
import {
  PUBLISH_BEFORE_DELIVERY_DENIED,
  SEND_PACK_DENIED,
} from '../../../domains/chat/group-profile/delivery-publish.ts';
import { groupRunProfile } from '../../../domains/chat/group-profile/group-profile.ts';
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
  /** Текст отказа агенту из последнего ответа маршрута. */
  let lastMessage = '';
  const ask = async (chatId: string, command: string, toolName = 'Bash'): Promise<string> => {
    asked += 1;
    const toolUseId = `tool-${asked}`;
    const input =
      toolName === 'Bash' || toolName === 'PowerShell' ? { command } : { file_path: command };
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
    const answered = pending.then((res) => {
      const body = res.json<{ behavior: string; message?: string }>();
      lastMessage = body.message ?? '';
      return body.behavior;
    });
    const deadline = Date.now() + 10_000;
    let settled = 'pending';
    void answered.then((behavior) => (settled = behavior));
    while (settled === 'pending' && !hasCard() && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10));
    }
    // Группу никто не смотрит (решения 23.10): вместо карточки — D-n человеку
    // (`deferred`) или отказ с известным ответом (`refused`: слияние, push в main).
    if (settled === 'deny' && deferredIdOf(lastMessage)) return 'deferred';
    if (settled === 'deny' && isPanelRefusal(lastMessage)) return 'refused';
    if (settled !== 'pending') return settled;
    const card = hasCard();
    session.abort(chatId);
    await pending;
    return card ? 'card' : 'pending-without-card';
  };

  /**
   * НАСТОЯЩИЙ снимок оболочки CLI в `CLAUDE_CONFIG_DIR/shell-snapshots` на время
   * `run` — маршрут читает его сам, как у живой группы.
   */
  const withSnapshot = async (text: string, run: () => Promise<void>): Promise<void> => {
    const cli = join(root, 'cli');
    mkdirSync(join(cli, 'shell-snapshots'), { recursive: true });
    writeFileSync(join(cli, 'shell-snapshots', 'snapshot-bash-1792797976969-abcdef.sh'), text);
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cli;
    try {
      await run();
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
    }
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
    expect(await ask(GROUP, 'psql -c "drop table users"')).toBe('deferred');
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
    expect(await ask(GROUP, '', 'mcp__gitlab__merge_merge_request')).toBe('refused');
    expect(await ask(GROUP, '', 'mcp__gitlab__delete_branch')).toBe('deferred');
    expect(await ask(GROUP, '', 'mcp__atlassian__jira_delete_issue')).toBe('deferred');
    expect(await ask(GROUP, '', 'mcp__gitlab__get_merge_request')).toBe('allow');
    expect(await ask(GROUP, '', 'mcp__atlassian__jira_get_issue')).toBe('allow');
  });

  /**
   * RF-BGCD-07: звено до доставки (профиль группы с `ahead.deliver`) публиковало
   * ветку формами мимо шаблона `deny` CLI (`bash -c 'git push'`, `Git push`,
   * `git send-pack`): брокер пуш своей ветки разрешал сам. Профиль — настоящий
   * `groupRunProfile`, метка доходит до маршрута через реестр прогонов.
   */
  it('звено до доставки не публикует ни в какой записи; коммит и работа — сами (RF-BGCD-07)', async () => {
    registry.setGroupProfileResolver((keys) =>
      keys.includes(GROUP)
        ? groupRunProfile({
            entries: [],
            tasksText: '',
            extra: [],
            stage: 'work',
            ahead: { deliver: true },
          })
        : undefined,
    );
    registry.stop(GROUP);
    startRun(GROUP);
    for (const command of [
      "bash -c 'git push origin feature/a'",
      'Git push origin feature/a',
      'GIT.EXE push origin feature/a',
      'eval git push origin feature/a',
      'git send-pack origin feature/a',
      'git push origin feature/a',
      'gh pr create --fill',
    ]) {
      expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → deny`);
      expect(lastMessage).toBe(PUBLISH_BEFORE_DELIVERY_DENIED);
    }
    expect(await ask(GROUP, 'git commit -m "группа"')).toBe('allow');
    expect(await ask(GROUP, "bash -c 'pnpm build'")).toBe('allow');
    // Инструмент PowerShell — тот же рубеж (R3): раньше проверка смотрела только Bash.
    for (const command of [
      'git push origin feature/a',
      '& git push origin feature/a',
      'git.exe push origin feature/a',
      "Start-Process git -ArgumentList 'push','origin','feature/a'",
      'gh pr create --fill',
    ]) {
      expect(`PS ${command} → ${await ask(GROUP, command, 'PowerShell')}`).toBe(
        `PS ${command} → deny`,
      );
      expect(lastMessage).toBe(PUBLISH_BEFORE_DELIVERY_DENIED);
    }
    expect(await ask(GROUP, 'git commit -m "группа"', 'PowerShell')).toBe('allow');
  });

  it('инструмент PowerShell: `git send-pack` группе — отказ, как в Bash (R2)', async () => {
    for (const command of ['git send-pack origin main', 'git send-pack origin feature/a']) {
      expect(`PS ${command} → ${await ask(GROUP, command, 'PowerShell')}`).toBe(
        `PS ${command} → deny`,
      );
      expect(lastMessage).toBe(SEND_PACK_DENIED);
    }
  });

  it('звено доставки пушит свою ветку, но не `git send-pack` (RF-BGCD-07)', async () => {
    expect(await ask(GROUP, "bash -c 'git push origin feature/a'")).toBe('allow');
    for (const command of ['git send-pack origin main', 'git send-pack origin feature/a']) {
      expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → deny`);
      expect(lastMessage).toBe(SEND_PACK_DENIED);
    }
  });

  it('обычный чат без тумблера — как раньше: коммит карточкой', async () => {
    expect(await ask(PLAIN, 'git commit -m "чат"')).toBe('card');
  });

  /** Решение владельца 23.10: удаление данных git и слияние — человеку и в одиночном чате. */
  it('одиночный чат с тумблером: удаление веток, тегов и слияние — карточка', async () => {
    session.armAutoApprove(PLAIN, { enabled: true, allowEdits: true });
    expect(await ask(PLAIN, 'git commit -m "чат"')).toBe('allow');
    for (const command of [
      'git branch -D old',
      'git tag -d v1',
      'git push origin --delete old',
      'git merge feat/x',
      'git status && git stash drop',
    ]) {
      expect(`${command} → ${await ask(PLAIN, command)}`).toBe(`${command} → card`);
    }
  });

  /**
   * Незакоммиченное копии группы (решения владельца 23.10): смена ветки на
   * грязном дереве — отказ агенту с порядком «сперва закоммить»; затирание —
   * само, но после снимка в `refs/agentdeck/backup/…`, из которого правку видно.
   */
  it('грязное дерево: смена ветки — отказ, затирание — само со снимком', async () => {
    const gitOut = (...args: string[]): string =>
      execFileSync('git', args, { cwd: copy, encoding: 'utf8' }).trim();
    execFileSync('git', ['branch', 'feature/b'], { cwd: copy });
    writeFileSync(join(copy, 'wip.txt'), 'unsaved work\n');
    expect(await ask(GROUP, 'git switch feature/b')).toBe('deny');
    expect(lastMessage).toContain('commit the current edits on this branch first');
    expect(gitOut('for-each-ref', 'refs/agentdeck/backup/')).toBe('');
    expect(await ask(GROUP, 'git clean -fd')).toBe('allow');
    const backup = gitOut('for-each-ref', '--format=%(refname)', 'refs/agentdeck/backup/');
    expect(backup).toMatch(/^refs\/agentdeck\/backup\//);
    expect(gitOut('show', `${backup}:wip.txt`)).toBe('unsaved work');
  });

  it('чистое дерево: смена ветки и затирание — сами, без снимка', async () => {
    execFileSync('git', ['branch', 'feature/b'], { cwd: copy });
    expect(await ask(GROUP, 'git switch feature/b')).toBe('allow');
    expect(await ask(GROUP, 'git reset --hard')).toBe('allow');
    const refs = execFileSync('git', ['for-each-ref', 'refs/agentdeck/backup/'], {
      cwd: copy,
      encoding: 'utf8',
    });
    expect(refs.trim()).toBe('');
  });

  it('строка проекта сильнее общей; общая действует там, где проект не трогал', async () => {
    store.setSplitSettings(project, { deliver: true, permissions: { gitWrite: false } });
    expect(await ask(GROUP, 'git commit -m "группа"')).toBe('deferred');

    store.setSplitDefaults({
      ...structuredClone(SPLIT_DEFAULTS_BUILTIN),
      permissions: { ...SPLIT_DEFAULTS_BUILTIN.permissions, filesDelete: false, routine: false },
    });
    expect(await ask(GROUP, 'rm -rf dist')).toBe('deferred');
    expect(await ask(GROUP, 'pnpm build')).toBe('deferred');

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
    expect(await ask(GROUP, 'a.txt', 'Edit')).toBe('deferred');
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
    expect(await ask(GROUP, 'git commit -m "группа"')).toBe('deferred');
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
  it('перезапись своей ветки (аренда и `--force`) — сама, чужой — карточка', async () => {
    // Решение 23.10: `--force` своей ветки — как аренда; ветку MR на ревью решает конфликт.
    expect(await ask(GROUP, 'git push --force origin feature/a')).toBe('allow');
    expect(await ask(GROUP, 'git push -f origin HEAD:feature/a')).toBe('allow');
    expect(await ask(GROUP, 'git push --force origin HEAD:feature/other')).toBe('deferred');
    expect(await ask(GROUP, 'git push --force-with-lease origin feature/a')).toBe('allow');
    expect(await ask(GROUP, 'git push --force-with-lease origin HEAD:feature/a')).toBe('allow');
    expect(await ask(GROUP, 'git push --force-with-lease origin main')).toBe('refused');
    expect(
      await ask(GROUP, 'git push --force-with-lease origin feature/a && git push -f origin main'),
    ).toBe('refused');
    // Пуш у человека — и аренда своей ветки тоже.
    store.setSplitSettings(project, { deliver: true, permissions: { gitWrite: 'human' } });
    expect(await ask(GROUP, 'git push --force-with-lease origin feature/a')).toBe('deferred');
  });

  /**
   * Просьба владельца 19.10: человека заваливало карточками на рутине группы.
   * Пример с карточки — составная команда в своей копии, ветка группы заведена
   * по правилу проекта (ключи через запятую), а не та, что в записи разделения.
   */
  const OWN = 'fix-PROJ-1567,PROJ-1589,PROJ-1626/kb-models-upload-errors';
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
    // Ссылки `origin/main` в копии нет — конфликт не сверить: отказ агенту, не «можно» (23.10).
    expect(await ask(GROUP, inCopy('git fetch origin && git rebase origin/main'))).toBe('deny');
    expect(lastMessage).toContain('could not check');
    expect(await ask(GROUP, 'git stash push -m "wip" && git stash pop')).toBe('allow');
    expect(await ask(GROUP, 'rm -rf .agent/tmp/probe')).toBe('allow');
    // Политика 19.10: обычный пуш рабочей ветки — сам, и не только своей.
    expect(await ask(GROUP, inCopy('git push origin HEAD:feature/other'))).toBe('allow');
    expect(await ask(GROUP, `git -C "${at()}" push origin "HEAD:${OWN}"`)).toBe('allow');
    expect(await ask(GROUP, inCopy('rm -rf dist coverage && rm -f build.log'))).toBe('allow');
  });

  it('сверка с основной, подстановки и черновик heredoc — сами; исполнимое в них — карточка (23.10)', async () => {
    checkout(OWN);
    // Команды с карточек владельца 23.10: `$(…)`, `${…}`, `@{u}`, heredoc шли человеку.
    const routine = [
      'git merge-tree --write-tree --name-only HEAD origin/main | head -3; echo A=${PIPESTATUS[0]}; git version',
      'git fetch origin 2>&1 | tail -2; git rev-parse --abbrev-ref @{u} 2>&1 | head -1; ls .agent 2>/dev/null | head -40',
      'git merge-base HEAD origin/main; git diff --stat $(git merge-base HEAD origin/main)...HEAD | tail -70',
      "cat > .agent/tmp/edit.txt <<'EOF'\nplaceholder\nEOF\nrm .agent/tmp/edit.txt; sed -n 1,5p README.md | grep -n x",
      // Карточка, ждавшая 4 ч 21 мин (23.10), дословно, кроме имени модуля проекта.
      'cat > .agent/tmp/go-test-edit.txt <<\'EOF\'\nplaceholder\nEOF\nrm .agent/tmp/go-test-edit.txt; grep -n "ниже\\|wantStatus: http.StatusBadRequest" svc-auth/internal/http/handlers_list_filters_test.go | head; sed -n 257,330p svc-auth/internal/http/handlers_list_filters_test.go | grep -n "name:" ',
      // Сценарий в оболочку судится своими звеньями: удалить восстановимое из git — уборка.
      // Каталог назван `cd`: транскрипта у заглушки CLI нет, и без него
      // относительное удаление — карточка (F-29, отдельный тест ниже).
      `cd "${at()}" && bash <<'EOF'\nrm -rf src\nEOF`,
      `cd "${at()}" && cat <<'EOF' | bash\nrm -rf src\nEOF`,
    ];
    for (const command of routine)
      expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → allow`);
    // Группу никто не смотрит: исполнимое уходит человеку D-n, push в main — отказ.
    const human: ReadonlyArray<readonly [string, 'deferred' | 'refused']> = [
      ["bash <<'EOF'\nrm -rf .agent\nEOF", 'deferred'],
      ["psql <<'SQL'\nDROP TABLE users;\nSQL", 'deferred'],
      ['echo "$(git push origin main)"', 'refused'],
      ["cat <<'EOF' | bash\nrm -rf .git\nEOF", 'deferred'],
    ];
    for (const [command, outcome] of human)
      expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → ${outcome}`);
  });

  it('пробный репозиторий в свежем `mktemp -d` — сам, переназначенная переменная — карточка (23.10)', async () => {
    checkout(OWN);
    // Карточка группы №1 (23.10, 08:02Z), дословно.
    const probe =
      'd=$(mktemp -d); cd "$d"; git init -q; echo a > a.txt; git add --all; time (timeout 60 git commit -q -m x; echo "commit exit $?"); cd /; rm -rf "$d" 2>/dev/null; echo done';
    expect(await ask(GROUP, probe)).toBe('allow');
    // Строки git копии выключены: пробный репозиторий — не история копии, он сам;
    // коммит в копии — карточка.
    store.setSplitSettings(project, {
      deliver: true,
      permissions: { gitWrite: false, gitHistory: false },
    });
    expect(await ask(GROUP, probe)).toBe('allow');
    expect(await ask(GROUP, 'git commit -q -m x')).toBe('deferred');
    store.setSplitSettings(project, { deliver: true, permissions: null });
    // Переменную переназначили — удаляется уже не свежий временный каталог.
    expect(await ask(GROUP, 'd=$(mktemp -d); d=/srv/repo; cd /; rm -rf "$d"')).toBe('deferred');
    expect(await ask(GROUP, 'd=$(mktemp -d); rm -rf "$d/../x"')).toBe('deferred');
  });

  it('опасное в той же форме, что пример владельца, — карточка', async () => {
    checkout(OWN);
    // Группу никто не смотрит (решения 23.10): слияние и push в main/защищённую
    // ветку — отказ с известным ответом (`refused`), остальное — D-n (`deferred`).
    const human: ReadonlyArray<readonly [string, 'deferred' | 'refused']> = [
      [inCopy('git push origin HEAD:main'), 'refused'],
      ['git push origin main', 'refused'],
      ['git push origin master', 'refused'],
      [inCopy('git push --force-with-lease origin HEAD:main'), 'refused'],
      [inCopy('git push --force origin HEAD:main'), 'refused'],
      [inCopy('git push -f origin HEAD:feature/other'), 'deferred'],
      [`git -C "${at()}" push origin main`, 'refused'],
      [`git -C "${at()}" push origin HEAD:main`, 'refused'],
      // `develop` — защищённая ветка (`isProtectedBranch`), как main.
      [inCopy('git fetch && git push origin HEAD:develop'), 'refused'],
      [inCopy(`git push --force-with-lease origin "HEAD:${OWN}" "HEAD:feature/other"`), 'deferred'],
      [inCopy('git push origin :feature/old'), 'deferred'],
      [inCopy('git stash drop'), 'deferred'],
      [inCopy('rm -rf .agent/notes.md'), 'deferred'],
      [inCopy('rm -f .env'), 'deferred'],
      ['psql -c "drop table users"', 'deferred'],
      ['gh pr merge 5 --squash', 'refused'],
      [inCopy(`git push origin --delete "${OWN}"`), 'deferred'],
      [inCopy(`git push origin ":${OWN}"`), 'deferred'],
      [inCopy(`git push origin "+HEAD:${OWN}"`), 'deferred'],
      [inCopy(`git push upstream "HEAD:${OWN}"`), 'deferred'],
      // «Слить, когда пройдёт конвейер» — то же слияние руками агента.
      [
        inCopy(`git push -o merge_request.merge_when_pipeline_succeeds origin "HEAD:${OWN}"`),
        'refused',
      ],
      // Слияние В main той же командой — шаг владельца, не вопрос.
      [inCopy(`git checkout main && git merge "${OWN}"`), 'refused'],
      // Затирание вне своей копии и игнорируемого — человеку при «истории git» `auto` (23.10).
      [`git -C "${project.replace(/\\/g, '/')}" reset --hard HEAD`, 'deferred'],
      [inCopy('git clean -fdx'), 'deferred'],
      [inCopy(`git branch -D "${OWN}"`), 'deferred'],
      [inCopy('git tag -d v1'), 'deferred'],
      [
        'curl -X PUT -H "PRIVATE-TOKEN: x" https://git.example.com/api/v4/projects/1/merge_requests/5/merge',
        'refused',
      ],
      ['gh api -X PUT repos/team/repo/pulls/5/merge', 'refused'],
      ['psql -c "insert into users values (1)"', 'deferred'],
      ['psql -c "update users set name = 1"', 'deferred'],
      [inCopy('rm -rf ../repo'), 'deferred'],
      // На Linux tmpdir — сам `/tmp`, а путь, записанный как `/tmp/…`, временный по
      // замыслу (paths.ts `TEMP_PREFIX`): по тексту копию в нём от мусора не отличить.
      ...(/^\/(var\/)?tmp\//.test(root)
        ? []
        : [[`rm -rf "${root.replace(/\\/g, '/')}/repo"`, 'deferred'] as const]),
    ];
    for (const [command, outcome] of human)
      expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → ${outcome}`);
    expect(await ask(GROUP, '', 'mcp__gitlab__merge_merge_request')).toBe('refused');
  });

  /**
   * Политика владельца 23.10: удаление и откат того, что git вернёт или что
   * создала сама группа, — уборка; то, чего git не вернёт (игнорируемое, локальный
   * слой, `.git`, корень копии, всё вне её), — человеку. Что игнорируется, маршрут
   * читает у git копии — здесь `.gitignore` с `secrets/`.
   */
  it('удаление восстановимого и игнорируемого своего — само; секрет, локальный слой и корень — карточка (23.10)', async () => {
    writeFileSync(join(copy, '.gitignore'), 'secrets/\ne2e-out/\n');
    mkdirSync(join(copy, 'secrets'), { recursive: true });
    writeFileSync(join(copy, 'secrets', 'key.txt'), 'x');
    mkdirSync(join(copy, 'e2e-out'), { recursive: true });
    writeFileSync(join(copy, 'e2e-out', 'probe.txt'), 'x');
    writeFileSync(join(copy, 'e2e-out', 'tls.pem'), 'x');
    // Каталог оболочки — из транскрипта CLI (N4); у заглушки его нет, и
    // относительное невременное удаление без `cd` — карточка (F-29).
    const routine = [
      inCopy('rm -rf src'),
      inCopy('rm -f notes.txt'),
      inCopy('rm -rf src docs/old && rm -f build.log'),
      inCopy('git checkout -- go.mod web/go.mod; git status --short | head'),
      inCopy('git restore --staged --worktree src/a.ts'),
      inCopy('S=.agent/tmp/x; rm -rf "$S"'),
      'find . -name "*.log" -delete',
      // Игнорируемое вне локального слоя и не секрет — своя уборка (R-C02).
      inCopy('rm -f e2e-out/probe.txt'),
      inCopy('rm -rf e2e-out/run-1'),
    ];
    for (const command of routine)
      expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → allow`);
    const cards = [
      'rm -rf src',
      // Вне копии своё — только рабочая папка этой сессии CLI (F-77).
      'rm -rf "$TMPDIR/agent-probe"',
      'rm -rf secrets',
      // Игнорируемое с именем секрета: git не вернёт, а зеркало могло не копировать.
      inCopy('rm -f secrets/key.txt'),
      inCopy('rm -f e2e-out/tls.pem'),
      inCopy('rm -rf .agent/notes.md'),
      inCopy('rm -rf .'),
      inCopy('rm -rf .git'),
      inCopy('rm -rf ../repo'),
      'find . -delete',
      'rm -rf $(cat list.txt)',
    ];
    // Удаление того, чего git не вернёт, решает человек — списком D-n, не карточкой.
    for (const command of cards)
      expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → deferred`);
    // Перезапись из git в своей копии решает строка «история git»: из коробки
    // `auto` (23.10) — сама; строка «человек» — карточка.
    expect(await ask(GROUP, inCopy('git checkout -- .env'))).toBe('allow');
  });

  it('своя ветка — та, что стоит в копии по git, а не названная в команде', async () => {
    // В записи разделения — feature/a, в копии — feature/b: своя — feature/b.
    checkout('feature/b');
    expect(await ask(GROUP, 'git push --force-with-lease origin HEAD:feature/a')).toBe('deferred');
    // Обычный пуш в другую рабочую ветку — перемотка вперёд, сам (политика 19.10).
    expect(await ask(GROUP, 'git push origin HEAD:feature/a')).toBe('allow');
    expect(await ask(GROUP, 'git push --force-with-lease origin HEAD:feature/b')).toBe('allow');
    // Свежая основная в свою рабочую ветку — сама: сито «интеграция» велит убрать
    // конфликт, а карточка держала группу до утра (политика 23.10).
    // Без `origin/main` в копии конфликт не сверить — отказ агенту; при конфликте —
    // сама (тест с настоящим `origin` ниже).
    expect(await ask(GROUP, 'git fetch origin && git merge origin/main')).toBe('deny');
    // Удаление ветки — данные git, человеку и при `-d` (пересмотр владельца 23.10).
    expect(await ask(GROUP, 'git branch -d feature/old')).toBe('deferred');
    // В копии основная ветка — пуш в неё и слияние в неё у человека, в какой форме ни будь.
    checkout('main');
    expect(await ask(GROUP, 'git push origin HEAD')).toBe('refused');
    expect(await ask(GROUP, 'git push')).toBe('refused');
    expect(await ask(GROUP, 'git merge feature/a')).toBe('refused');
    // Пуш из чужого каталога — уже не своя копия.
    checkout('feature/a');
    expect(
      await ask(
        GROUP,
        `cd "${project.replace(/\\/g, '/')}" && git push --force-with-lease origin HEAD:feature/a`,
      ),
    ).toBe('deferred');
    expect(await ask(GROUP, `git -C "${project}" push origin HEAD:feature/a`)).toBe('deferred');
  });

  /**
   * Журнал 19.10 02:17:02 (L7.12): доставленная группа после пустого rebase
   * переписала арендой ветку MR, снятого с черновика и стоявшего на ревью.
   * Состояние MR знает только фордж — здесь это заглушка GitLab на свободном
   * порту, а маршрут прав и хранилище настоящие.
   */
  it('аренда своей ветки при MR на ревью без конфликта — отказ агенту без карточки; черновик — сама', async () => {
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

      // Ключа к форджу нет — MR считается на ревью, конфликт не известен: отказ
      // агенту с причиной, карточки нет (решение 23.10).
      expect(await ask(GROUP, lease)).toBe('deny');
      expect(lastMessage).toContain('could not be read');
      expect(reads).toBe(0);

      writeSettings(store, 'gitlab', { enabled: true, baseUrl: site, repo: '' });
      writeToken(join(root, 'agentdeck'), 'gitlab', 'stub-key');
      expect(await ask(GROUP, lease)).toBe('allow');
      expect(reads).toBe(1);

      draft = false;
      expect(await ask(GROUP, lease)).toBe('deny');
      expect(await ask(GROUP, 'git push --force-with-lease origin HEAD:feature/a')).toBe('deny');
      expect(await ask(GROUP, 'git push --force origin feature/a')).toBe('deny');
      // Обычный коммит фордж не спрашивает: сеть — только когда она решает исход.
      reads = 0;
      expect(await ask(GROUP, 'git commit -m "группа"')).toBe('allow');
      expect(reads).toBe(0);

      // Фордж не ответил — конфликт не известен: отказ агенту, не молчаливое «можно».
      forge.closeAllConnections();
      await new Promise<void>((done) => forge.close(() => done()));
      draft = true;
      expect(await ask(GROUP, lease)).toBe('deny');
      expect(events.some((event) => event.kind === 'permission')).toBe(false);
    } finally {
      if (forge.listening) await new Promise<void>((done) => forge.close(() => done()));
    }
  });

  /**
   * Решение владельца 23.10: rebase, догон и перезапись ветки MR — только при
   * конфликте с целевой. Настоящий `origin` (голый репозиторий), настоящий git
   * копии и заглушка форджа на свободном порту.
   */
  describe('только при конфликте: настоящий origin', () => {
    const gitIn = (cwd: string, ...args: string[]): string =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd,
        encoding: 'utf8',
      }).trim();
    /** origin/main и origin/feature/a; `same` — main правит ту же строку, что и ветка. */
    const withOrigin = (same: boolean): void => {
      const bare = join(root, 'origin.git');
      gitIn(root, 'init', '--bare', '-q', bare);
      gitIn(project, 'remote', 'add', 'origin', bare);
      gitIn(project, 'checkout', '-q', '-B', 'main');
      writeFileSync(join(project, 'a.txt'), 'base\n');
      gitIn(project, 'add', '.');
      gitIn(project, 'commit', '-qm', 'base');
      gitIn(project, 'push', '-q', 'origin', 'main');
      gitIn(copy, 'reset', '-q', '--hard', 'main');
      writeFileSync(join(copy, 'a.txt'), 'feature\n');
      gitIn(copy, 'commit', '-qam', 'feature');
      gitIn(copy, 'push', '-q', 'origin', 'feature/a');
      writeFileSync(join(project, same ? 'a.txt' : 'b.txt'), 'main moved\n');
      gitIn(project, 'add', '.');
      gitIn(project, 'commit', '-qm', 'main moved');
      gitIn(project, 'push', '-q', 'origin', 'main');
    };
    const withForge = async (
      body: () => Record<string, unknown>,
    ): Promise<{ url: string; close: () => Promise<void> }> => {
      const forge = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            iid: 5,
            title: 'Группа A',
            state: 'opened',
            draft: false,
            source_branch: 'feature/a',
            target_branch: 'main',
            ...body(),
          }),
        );
      });
      await new Promise<void>((done) => forge.listen(0, '127.0.0.1', done));
      const site = `http://127.0.0.1:${(forge.address() as AddressInfo).port}`;
      writeSettings(store, 'gitlab', { enabled: true, baseUrl: site, repo: '' });
      writeToken(join(root, 'agentdeck'), 'gitlab', 'stub-key');
      const url = `${site}/team/repo/-/merge_requests/5`;
      const plan = store.getSplitPlan('parent') as SplitPlanRecord;
      store.setSplitPlan({
        ...plan,
        groups: plan.groups.map((group) => ({ ...group, mr: url })),
      } as SplitPlanRecord);
      return {
        url,
        close: async () => {
          forge.closeAllConnections();
          await new Promise<void>((done) => forge.close(() => done()));
        },
      };
    };
    const cards = (): number => events.filter((event) => event.kind === 'permission').length;

    it('MR на ревью без конфликта: аренда и `--force` — отказ агенту, карточки нет', async () => {
      withOrigin(false);
      const forge = await withForge(() => ({ has_conflicts: false }));
      try {
        for (const command of [
          'git push --force-with-lease origin feature/a',
          'git push --force origin HEAD:feature/a',
          'git push -f origin feature/a',
        ]) {
          expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → deny`);
          expect(lastMessage).toContain('has no conflict');
        }
        expect(cards()).toBe(0);
        // Обычный пуш новых коммитов — сам.
        expect(await ask(GROUP, 'git push origin feature/a')).toBe('allow');
      } finally {
        await forge.close();
      }
    });

    it('MR на ревью с конфликтом (по форджу или по origin) — аренда сама, с отметкой', async () => {
      withOrigin(true);
      let forgeSays: boolean | undefined = true;
      const forge = await withForge(() =>
        forgeSays === undefined ? {} : { has_conflicts: forgeSays },
      );
      try {
        expect(await ask(GROUP, 'git push --force-with-lease origin feature/a')).toBe('allow');
        // Фордж ещё не пересчитал (молчит или говорит «нет») — конфликт видно по origin.
        forgeSays = false;
        expect(await ask(GROUP, 'git push --force origin feature/a')).toBe('allow');
        forgeSays = undefined;
        expect(await ask(GROUP, 'git push -f origin HEAD:feature/a')).toBe('allow');
        expect(cards()).toBe(0);
        const notices = (store.getSplitPlan('parent') as SplitPlanRecord).groups[0]?.autoNotices;
        expect(notices?.length).toBe(3);
      } finally {
        await forge.close();
      }
    });

    it('фордж недоступен, конфликта по origin нет — отказ агенту', async () => {
      withOrigin(false);
      const forge = await withForge(() => ({}));
      await forge.close();
      expect(await ask(GROUP, 'git push --force-with-lease origin feature/a')).toBe('deny');
      expect(lastMessage).toContain('has no conflict');
      expect(cards()).toBe(0);
    });

    /**
     * F-31: `origin/*` копии пишет сам агент. Подменённый `origin/main` на
     * конфликтующий коммит раньше «находил» конфликт и открывал перезапись ветки
     * на ревью; теперь вершины берутся у сервера.
     */
    it('подменённый `origin/main` копии конфликта не создаёт — отказ агенту (F-31)', async () => {
      withOrigin(false);
      const forge = await withForge(() => ({ has_conflicts: false }));
      try {
        gitIn(copy, 'checkout', '-q', '-b', 'fake', 'main~1');
        writeFileSync(join(copy, 'a.txt'), 'fake conflict\n');
        gitIn(copy, 'commit', '-qam', 'fake');
        gitIn(copy, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
        gitIn(copy, 'checkout', '-q', 'feature/a');
        expect(await ask(GROUP, 'git push --force-with-lease origin feature/a')).toBe('deny');
        expect(lastMessage).toContain('has no conflict');
        expect(cards()).toBe(0);
      } finally {
        await forge.close();
      }
    });

    /** F-32: перестановка своей ветки на целевую — тот же догон. */
    it('`reset --hard` и `branch -f` на origin/main без конфликта — отказ агенту (F-32)', async () => {
      withOrigin(false);
      for (const command of [
        'git reset --hard origin/main',
        'git rebase -X theirs origin/main',
        'git switch -c fresh origin/main',
      ]) {
        expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → deny`);
        expect(lastMessage).toContain('NO conflicts');
      }
      expect(cards()).toBe(0);
    });

    it('догон main без конфликта — отказ в любой форме: имя, хэш, `checkout -B` (D2)', async () => {
      withOrigin(false);
      const sha = gitIn(copy, 'rev-parse', 'origin/main');
      for (const command of [
        'git rebase origin/main',
        'git merge origin/main',
        `git rebase ${sha}`,
        `git merge ${sha}`,
        'git checkout -B feature/a origin/main',
        `git switch -C feature/a ${sha}`,
      ]) {
        expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → deny`);
        expect(lastMessage).toContain('NO conflicts');
      }
      // Перенос внутри своей истории — не догон.
      expect(await ask(GROUP, `git rebase ${gitIn(copy, 'rev-parse', 'HEAD~1')}`)).toBe('allow');
      expect(cards()).toBe(0);
    });

    /**
     * RF-BGCD-12b, раунд 9: догон, разделённый на два вызова, — содержимое целевой
     * в файл или дерево, наложение следующим вызовом (`git apply p`, `patch`, `cp`).
     * Второй шаг целевую уже не называет, поэтому отказ — на записи.
     */
    it('содержимое main в файл или дерево без конфликта — отказ агенту, просмотр — сам (раунд 9)', async () => {
      withOrigin(false);
      for (const command of [
        'git diff HEAD origin/main > p.diff',
        'git format-patch HEAD..origin/main',
        'git show origin/main:a.txt > a.txt',
        'git archive origin/main | tar -x -C ../m',
        'echo "$(git diff HEAD origin/main)" > p.diff',
      ]) {
        expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → deny`);
        expect(lastMessage).toContain('NO conflicts');
      }
      for (const command of [
        'git diff HEAD origin/main | head -20',
        'git diff --stat origin/main > s.txt',
        'git diff origin/main...HEAD > own.diff',
      ]) {
        expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → allow`);
      }
      expect(cards()).toBe(0);
    });

    /**
     * RF-BGCD-05: `git fetch . +X:refs/remotes/origin/main` — рутина, мимо правил
     * `update-ref`. Подменённый так `origin/main` «находил» конфликт для догона и
     * прятал догон по хэшу настоящей main; теперь сверка — по вершине сервера.
     */
    it('подменённый fetch-ом `origin/main`: догон не проходит, догон по хэшу не прячется (RF-BGCD-05)', async () => {
      withOrigin(false);
      const sha = gitIn(copy, 'rev-parse', 'origin/main');
      gitIn(copy, 'checkout', '-q', '-b', 'fake', 'main~1');
      writeFileSync(join(copy, 'a.txt'), 'fake conflict\n');
      gitIn(copy, 'commit', '-qam', 'fake');
      gitIn(copy, 'checkout', '-q', 'feature/a');
      gitIn(copy, 'fetch', '-q', '.', '+fake:refs/remotes/origin/main');
      expect(await ask(GROUP, 'git rebase origin/main')).toBe('deny');
      expect(lastMessage).toContain('could not check');
      expect(await ask(GROUP, `git rebase ${sha}`)).toBe('deny');
      expect(lastMessage).toContain('NO conflicts');
      expect(cards()).toBe(0);
    });

    it('догон main с конфликтом — сам: имя, хэш, `checkout -B` (D2)', async () => {
      withOrigin(true);
      const sha = gitIn(copy, 'rev-parse', 'origin/main');
      for (const command of [
        'git rebase origin/main',
        'git merge origin/main',
        `git rebase ${sha}`,
        'git checkout -B feature/a origin/main',
      ]) {
        expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → allow`);
      }
      expect(cards()).toBe(0);
    });

    /**
     * Повторная проверка 24.10 (a): псевдоним снимка оболочки (`grb` = `git
     * rebase`) прятал догон от сверки конфликта — маршрут искал догон в тексте
     * как написано, и `grb origin/main` шёл рутиной без конфликта. `eval` исполняет
     * текст в той же оболочке — псевдонимы раскрываются и там.
     */
    it('догон псевдонимом снимка без конфликта — отказ агенту; своя история — сама', async () => {
      withOrigin(false);
      const sha = gitIn(copy, 'rev-parse', 'origin/main');
      await withSnapshot(
        "shopt -s expand_aliases\nalias -- grb='git rebase'\nalias -- gpl='git pull'\n" +
          "alias -- gmo='git merge origin/main'\nalias -- s='sudo '\n",
        async () => {
          for (const command of [
            'grb origin/main',
            'gpl origin main',
            'gmo',
            `grb ${sha}`,
            "eval 'grb origin/main'",
            'git fetch origin && grb origin/main',
          ]) {
            expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → deny`);
            expect(lastMessage).toContain('NO conflicts');
          }
          expect(await ask(GROUP, `grb ${gitIn(copy, 'rev-parse', 'HEAD~1')}`)).toBe('allow');
        },
      );
      expect(cards()).toBe(0);
    });

    it('догон псевдонимом снимка при конфликте — сам, как без псевдонима', async () => {
      withOrigin(true);
      await withSnapshot("alias -- grb='git rebase'\n", async () => {
        expect(await ask(GROUP, 'grb origin/main')).toBe('allow');
      });
      expect(cards()).toBe(0);
    });

    /**
     * Повторная проверка 24.10 (c): догон, чью цель не назвать (ссылка из
     * переменной или подстановки), проходил дальше и решался строками группы —
     * rebase без известного конфликта. Теперь его решает человек.
     */
    it('догон с целью, которую не назвать, — человеку (c)', async () => {
      withOrigin(false);
      for (const command of [
        'git rebase "$T"',
        'git rebase $(cat .agent/tmp/target)',
        'git pull origin "$B"',
        'git reset --hard `cat ref`',
      ]) {
        expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → deferred`);
      }
      // Своя история и обычная работа — сами.
      expect(await ask(GROUP, 'git rebase HEAD~1')).toBe('allow');
      expect(await ask(GROUP, 'git pull')).toBe('allow');
    });

    /**
     * Цель через `$(git rev-parse …)` или переменную с буквальной ссылкой — та же
     * целевая: читалась как `origin/main)` и отказ «не удалось сверить» даже при
     * конфликте, а `$T` уходил человеку.
     */
    it('догон с целью через rev-parse или переменную — сверка по самой ссылке', async () => {
      withOrigin(false);
      for (const command of [
        'git rebase $(git rev-parse origin/main)',
        'T=origin/main; git rebase $T',
      ]) {
        expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → deny`);
        expect(lastMessage).toContain('NO conflicts');
      }
    });

    it('догон с целью через rev-parse при конфликте — сам, как названный', async () => {
      withOrigin(true);
      expect(await ask(GROUP, 'git rebase $(git rev-parse origin/main)')).toBe('allow');
      expect(cards()).toBe(0);
    });

    /** Тот же догон инструментом PowerShell — та же сверка конфликта, что у Bash. */
    it('догон main инструментом PowerShell без конфликта — отказ агенту', async () => {
      withOrigin(false);
      for (const command of ['git rebase origin/main', 'git merge origin/main']) {
        expect(`${command} → ${await ask(GROUP, command, 'PowerShell')}`).toBe(`${command} → deny`);
        expect(lastMessage).toContain('NO conflicts');
      }
      expect(await ask(GROUP, 'git status', 'PowerShell')).toBe('allow');
    });
  });

  /**
   * Повторная проверка 24.10 (d): функции снимка оболочки CLI (из `.bashrc`,
   * формат CLI — `eval $'имя () …' > /dev/null 2>&1`) судились как неизвестное
   * имя: `gsync` с телом `git rebase origin/main` и `gp2 origin HEAD:main` с телом
   * `git push "$@"` шли правилами чата. Тело с git, удалением или погашением —
   * человеку; безобидное — само.
   */
  it('функция снимка оболочки: тело с git или удалением — человеку, безобидное — само (d)', async () => {
    await withSnapshot(
      [
        'shopt -s expand_aliases',
        "eval $'gsync () \\n{ \\n    git fetch origin && git rebase origin/main\\n}' > /dev/null 2>&1",
        'eval $\'gp2 () \\n{ \\n    git push "$@"\\n}\' > /dev/null 2>&1',
        'eval $\'wipe () \\n{ \\n    rm -rf "$1"\\n}\' > /dev/null 2>&1',
        "eval $'hello () \\n{ \\n    echo hi\\n}' > /dev/null 2>&1",
        '',
      ].join('\n'),
      async () => {
        const rows: ReadonlyArray<readonly [string, string]> = [
          ['gsync', 'deferred'],
          ['gp2 origin HEAD:main', 'deferred'],
          ['wipe dist', 'deferred'],
          ['git status && gsync', 'deferred'],
          ['hello', 'allow'],
          ['git status', 'allow'],
        ];
        for (const [command, expected] of rows) {
          expect(`${command} → ${await ask(GROUP, command)}`).toBe(`${command} → ${expected}`);
        }
      },
    );
  });

  /**
   * Раунд 10 (24.10): инструмент PowerShell шёл мимо разбора, псевдоним из
   * `.bashrc` (`gp` = `git push`) и `make -C` вне копии — тоже. Маршрут читает
   * НАСТОЯЩИЙ снимок оболочки CLI из `CLAUDE_CONFIG_DIR/shell-snapshots`.
   */
  it('PowerShell, псевдоним снимка оболочки и make -C вне копии — к человеку; соседи — сами (раунд 10)', async () => {
    const cli = join(root, 'cli');
    mkdirSync(join(cli, 'shell-snapshots'), { recursive: true });
    writeFileSync(
      join(cli, 'shell-snapshots', 'snapshot-bash-1792797976969-abcdef.sh'),
      "unalias -a 2>/dev/null || true\nshopt -s expand_aliases\nalias -- gp='git push'\nalias -- gst='git status'\n",
    );
    const before = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cli;
    try {
      const outside = join(root, 'other').replace(/\\/g, '/');
      const rows: ReadonlyArray<readonly [string, string, string]> = [
        ['PowerShell', `Remove-Item -Recurse -Force ${outside}`, 'deferred'],
        ['PowerShell', 'git push origin HEAD:main --force', 'refused'],
        ['PowerShell', 'Remove-Item -Recurse -Force ./dist', 'allow'],
        ['PowerShell', 'git status', 'allow'],
        // Своя ветка копии читается и для PowerShell: пуш `HEAD` — своей ветки.
        ['PowerShell', 'git push origin HEAD', 'allow'],
        // К человеку (D-n): отказ «пуш в main» в `deferred-bridge.ts` судит текст без псевдонимов.
        ['Bash', 'gp origin main --force', 'deferred'],
        ['Bash', 'gp origin HEAD', 'allow'],
        ['Bash', 'gst', 'allow'],
        ['Bash', `make -C ${outside} clean`, 'deferred'],
        ['Bash', 'make -C dist clean', 'allow'],
        ['Bash', 'make clean', 'allow'],
      ];
      for (const [tool, command, expected] of rows) {
        expect(`${tool} ${command} → ${await ask(GROUP, command, tool)}`).toBe(
          `${tool} ${command} → ${expected}`,
        );
      }
    } finally {
      if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = before;
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
    expect(await ask(GROUP, 'pnpm build')).toBe('deferred');
    expect(
      (store.getSplitPlan('parent') as SplitPlanRecord).groups[0]?.autoNotices,
    ).toBeUndefined();
  });
});
