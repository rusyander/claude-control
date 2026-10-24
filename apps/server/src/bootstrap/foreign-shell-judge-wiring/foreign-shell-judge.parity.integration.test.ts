import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deferredIdOf, isPanelRefusal } from '@agentdeck/contracts/deferred-asks';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type { ServerContext } from '../../context.ts';
import {
  ChatRunRegistry,
  type RunLike,
} from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.ts';
import { ChatSession } from '../../domains/chat/ChatSession/ChatSession.ts';
import type { ChatEvent } from '../../domains/chat/chat-events.ts';
import { groupRunProfile } from '../../domains/chat/group-profile/group-profile.ts';
import { writeSettings, writeToken } from '../../domains/integrations/store/store.ts';
import { answerCodexApproval } from '../../domains/provider-chat/live/codex-app-server.ts';
import { decidePermission } from '../../domains/provider-chat/live/permission.ts';
import {
  gooseShellAsk,
  opencodeShellAsk,
  qwenShellAsk,
} from '../../domains/provider-chat/live/shell-ask.ts';
import type {
  LivePermissionPolicy,
  LiveShellCall,
  LiveShellJudgement,
} from '../../domains/provider-chat/live/types.ts';
import type { ShellJudge } from '../../domains/provider-chat/ProviderChatService/ProviderChatService.ts';
import { deferredAsksOf } from '../../routes/chat/deferred-routes/deferred-store.ts';
import { registerChatRunRoutes } from '../../routes/chat/run-routes/run-routes.ts';
import { wireForeignShellJudge } from './foreign-shell-judge-wiring.ts';

/**
 * Паритет правил оболочки: одна команда — один ответ у Claude и у каждого чужого
 * CLI (P-01..P-05). Claude судит НАСТОЯЩИЙ маршрут прав (`run-routes.ts`) поверх
 * настоящего хранилища и настоящих копий git; чужой CLI — НАСТОЯЩИЙ судья,
 * собранный сборкой (`wireForeignShellJudge`), через провод своего CLI: codex —
 * его ответчик `answerCodexApproval`, qwen/goose/opencode — снятие команды с
 * провода (`shell-ask.ts`) и `decidePermission`. Формы провода — с живых проб 24.10.
 * Заглушены только процессы CLI.
 */

type Outcome = 'allow' | 'deferred' | 'refused' | 'deny' | 'card' | 'pending-without-card';

const RANK: Record<Outcome, number> = {
  'pending-without-card': 5,
  refused: 4,
  deny: 4,
  deferred: 3,
  card: 3,
  allow: 0,
};

/** Провод каждого CLI под команду и оболочку — как его шлёт сам CLI. */
interface Wire {
  name: string;
  providerId: string;
  /** Чтения Claude, с которыми сверяется ответ: известная оболочка — одно, `unknown` — оба. */
  tools: ('Bash' | 'PowerShell')[];
  decide: (command: string, policy: LivePermissionPolicy) => Promise<'allow' | 'deny'>;
}

const psQuote = (command: string): string => `'${command.replace(/'/g, "''")}'`;
const shQuote = (command: string): string => `'${command.replace(/'/g, `'\\''`)}'`;

const codexWire =
  (line: (command: string) => string) =>
  async (command: string, policy: LivePermissionPolicy): Promise<'allow' | 'deny'> => {
    const answer = (await answerCodexApproval(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'item/commandExecution/requestApproval',
        params: { command: line(command), cwd: '.', itemId: 'i1' },
      } as never,
      policy,
    )) as { decision: string };
    return answer.decision === 'accept' ? 'allow' : 'deny';
  };

const viaShellAsk =
  (cli: string, shellOf: (command: string) => LiveShellCall | undefined) =>
  (command: string, policy: LivePermissionPolicy): Promise<'allow' | 'deny'> => {
    const shell = shellOf(command);
    return decidePermission(policy, {
      cli,
      requestId: 'r1',
      tool: 'execute',
      ...(shell ? { shell } : {}),
    });
  };

const WIRES: Wire[] = [
  {
    name: 'codex win32 (pwsh -Command)',
    providerId: 'codex',
    tools: ['PowerShell'],
    decide: codexWire(
      (command) => `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command ${psQuote(command)}`,
    ),
  },
  {
    name: 'codex posix (bash -lc)',
    providerId: 'codex',
    tools: ['Bash'],
    decide: codexWire((command) => `/bin/bash -lc ${shQuote(command)}`),
  },
  {
    name: 'qwen posix',
    providerId: 'qwen',
    tools: ['Bash'],
    decide: viaShellAsk('qwen', (command) =>
      qwenShellAsk(
        { _meta: { toolName: 'run_shell_command' }, rawInput: { command }, kind: 'execute' },
        'linux',
      ),
    ),
  },
  {
    name: 'qwen win32 (оболочка не названа)',
    providerId: 'qwen',
    tools: ['Bash', 'PowerShell'],
    decide: viaShellAsk('qwen', (command) =>
      qwenShellAsk({ _meta: { toolName: 'run_shell_command' }, rawInput: { command } }, 'win32'),
    ),
  },
  {
    name: 'goose posix',
    providerId: 'goose',
    tools: ['Bash'],
    decide: viaShellAsk('goose', (command) =>
      gooseShellAsk({ title: `shell · ${command}`, rawInput: { command }, kind: 'other' }, 'linux'),
    ),
  },
  {
    name: 'goose win32',
    providerId: 'goose',
    tools: ['Bash', 'PowerShell'],
    decide: viaShellAsk('goose', (command) =>
      gooseShellAsk({ title: `shell · ${command}`, rawInput: { command } }, 'win32'),
    ),
  },
  {
    name: 'opencode posix',
    providerId: 'opencode',
    tools: ['Bash'],
    decide: viaShellAsk('opencode', (command) =>
      opencodeShellAsk({ permission: 'bash', patterns: [command] }, 'linux'),
    ),
  },
];

/** Таблица команд: строка и чтение Claude, которым она написана. */
const GROUP_ROWS: { command: string; tool: 'Bash' | 'PowerShell' }[] = [
  { command: 'git commit -m "группа"', tool: 'Bash' },
  { command: 'pnpm build', tool: 'Bash' },
  { command: 'rm -rf dist', tool: 'Bash' },
  { command: 'git push origin HEAD', tool: 'Bash' },
  { command: 'git push origin main', tool: 'Bash' },
  { command: 'git branch -D other', tool: 'Bash' },
  { command: 'git tag -d v1', tool: 'Bash' },
  { command: 'psql -c "drop table users"', tool: 'Bash' },
  { command: 'git send-pack origin main', tool: 'Bash' },
  { command: 'Get-ChildItem', tool: 'PowerShell' },
  { command: 'git commit -m "fix: x"', tool: 'PowerShell' },
  { command: 'git push origin main', tool: 'PowerShell' },
  { command: 'git branch -D other', tool: 'PowerShell' },
  { command: "Start-Process git -ArgumentList 'branch','-D','other'", tool: 'PowerShell' },
  { command: "Start-Process cmd -ArgumentList '/c','rd','/s','/q','src'", tool: 'PowerShell' },
  { command: "iex 'git branch -D other'", tool: 'PowerShell' },
  { command: 'git send-pack origin main', tool: 'PowerShell' },
  // Погашение не своего процесса (D-1): у Claude — отказ агенту с причиной, не D-n.
  // Номер — сам процесс теста: он есть в снимке и ничьей группе не принадлежит.
  { command: `kill ${process.pid}`, tool: 'Bash' },
  { command: `Stop-Process -Id ${process.pid} -Force`, tool: 'PowerShell' },
];

const CHAT_ROWS: { command: string; tool: 'Bash' | 'PowerShell' }[] = [
  { command: 'git commit -m "чат"', tool: 'Bash' },
  { command: 'git branch -D old', tool: 'Bash' },
  { command: 'git merge feat/x', tool: 'Bash' },
  { command: 'git push origin main', tool: 'Bash' },
  { command: 'gh pr merge 12 --squash', tool: 'Bash' },
  { command: 'Get-ChildItem', tool: 'PowerShell' },
  { command: 'Remove-Item -Recurse -Force src', tool: 'PowerShell' },
  { command: 'REMOVE-ITEM -recurse x', tool: 'PowerShell' },
  { command: 'git branch -D old', tool: 'PowerShell' },
  { command: "Start-Process git -ArgumentList 'branch','-D','old'", tool: 'PowerShell' },
];

describe('паритет правил оболочки: Claude и чужие CLI (P-01..P-05)', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let registry: ChatRunRegistry;
  let session: ChatSession;
  let events: ChatEvent[];
  let judge: ShellJudge;
  let copyA: string;
  let copyB: string;
  const detaches: (() => void)[] = [];
  const saved: Record<string, string | undefined> = {};
  const GROUP = 'group-chat';
  const PLAIN = 'plain-chat';
  const FOREIGN_GROUP = 'foreign-group';
  const FOREIGN_CHAT = 'foreign-chat';
  let deliverAhead = false;
  let ctx: ServerContext;
  const armed = new Map<string, { enabled: boolean; allowEdits: boolean }>();

  const liveRun = (): RunLike => ({
    start: () => new Promise(() => undefined),
    stop: () => undefined,
  });

  const startRun = (chatId: string, cwd: string): void => {
    registry.start(chatId, { prompt: 'задача', cwd }, { projectPath: cwd });
    detaches.push(
      registry.attach(chatId, 0, {
        send: ({ event }) => void events.push(event),
        close: () => undefined,
      }) as () => void,
    );
  };

  const classify = (behavior: string, message: string): Outcome => {
    if (behavior === 'allow') return 'allow';
    if (deferredIdOf(message)) return 'deferred';
    if (isPanelRefusal(message)) return 'refused';
    return 'deny';
  };

  let asked = 0;
  /** Ответ НАСТОЯЩЕГО маршрута прав Claude. */
  const claude = async (chatId: string, command: string, toolName: string): Promise<Outcome> => {
    asked += 1;
    const toolUseId = `tool-${asked}`;
    const pending = app.inject({
      method: 'POST',
      url: '/api/chat/permission-request',
      payload: { runId: chatId, toolName, input: { command }, toolUseId },
    });
    const hasCard = (): boolean =>
      events.some(
        (event) =>
          event.kind === 'permission' && (event as { toolUseId?: string }).toolUseId === toolUseId,
      );
    let settled: { behavior: string; message: string } | undefined;
    void pending.then((res) => {
      const body = res.json<{ behavior: string; message?: string }>();
      settled = { behavior: body.behavior, message: body.message ?? '' };
    });
    const deadline = Date.now() + 10_000;
    while (!settled && !hasCard() && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10));
    }
    if (settled) return classify(settled.behavior, settled.message);
    const card = hasCard();
    session.abort(chatId);
    await pending;
    // Снятие карточки гасит и тумблер прогона — следующая строка таблицы судилась
    // бы уже без него. Взводим обратно, как было до строки.
    const toggle = armed.get(chatId);
    if (toggle) session.armAutoApprove(chatId, toggle);
    return card ? 'card' : 'pending-without-card';
  };

  /** Ответ судьи чужого CLI через провод этого CLI. */
  const foreign = async (
    wire: Wire,
    chatId: string,
    workdir: string,
    command: string,
  ): Promise<Outcome> => {
    let verdict: LiveShellJudgement | undefined;
    let carded = false;
    const policy: LivePermissionPolicy = {
      allowEdits: true,
      ask: async () => {
        carded = true;
        return 'deny';
      },
      judge: async (shell, pid) => {
        verdict = await judge({
          providerId: wire.providerId,
          chatId,
          workdir,
          allowEdits: true,
          ...(pid ? { pid } : {}),
          shell,
        });
        return verdict;
      },
    };
    const decision = await wire.decide(command, policy);
    // Провод, с которого команду не сняли, судью не зовёт — и «да» переключателя
    // прошло бы мимо суда; это провал, а не ответ.
    expect(verdict, `${wire.name}: судья не позван для «${command}»`).toBeDefined();
    if (carded) return 'card';
    if (verdict?.behavior === 'allow') {
      expect(decision).toBe('allow');
      return 'allow';
    }
    expect(decision).toBe('deny');
    lastForeignMessage = verdict?.behavior === 'deny' ? (verdict.message ?? '') : '';
    return classify('deny', lastForeignMessage);
  };
  let lastForeignMessage = '';

  /** Эталон Claude для чтений провода: строжайшее из них. */
  const reference = async (
    chatId: string,
    command: string,
    tools: readonly string[],
  ): Promise<Outcome> => {
    const outcomes: Outcome[] = [];
    for (const tool of tools) outcomes.push(await claude(chatId, command, tool));
    return outcomes.reduce((worst, next) => (RANK[next] > RANK[worst] ? next : worst));
  };

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-shell-parity-'));
    const project = join(root, 'repo');
    copyA = join(root, 'repo-a');
    copyB = join(root, 'repo-b');
    mkdirSync(project, { recursive: true });
    const git = (cwd: string, args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });
    };
    git(project, ['init', '-q', '-b', 'main']);
    git(project, ['commit', '-q', '--allow-empty', '-m', 'init']);
    git(project, ['branch', 'other']);
    git(project, ['branch', 'old']);
    git(project, ['worktree', 'add', '-q', '-b', 'feature/a', copyA]);
    git(project, ['worktree', 'add', '-q', '-b', 'feature/b', copyB]);
    // Правила самого CLI (P-05) — из временных домов, не из настоящих.
    for (const key of ['QWEN_HOME', 'OPENCODE_CONFIG']) saved[key] = process.env[key];
    mkdirSync(join(root, 'qwen-home'), { recursive: true });
    process.env.QWEN_HOME = join(root, 'qwen-home');
    process.env.OPENCODE_CONFIG = join(root, 'opencode.json');
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    store.setSplitPlan({
      parentChatId: 'parent',
      projectPath: project,
      createdAt: new Date().toISOString(),
      order: [0, 1],
      request: { allowEdits: true },
      proposal: { groups: [] },
      groups: [
        { index: 0, branch: 'feature/a', status: 'running', chatId: GROUP, path: copyA },
        { index: 1, branch: 'feature/b', status: 'running', chatId: FOREIGN_GROUP, path: copyB },
      ],
    } as unknown as SplitPlanRecord);
    const at = new Date().toISOString();
    store.setChatLink(GROUP, {
      parentChatId: 'parent',
      groupIndex: 0,
      branch: 'feature/a',
      createdAt: at,
    });
    store.setChatLink(foreignChatKey('codex', FOREIGN_GROUP), {
      parentChatId: 'parent',
      groupIndex: 1,
      branch: 'feature/b',
      createdAt: at,
    });
    for (const providerId of ['qwen', 'goose', 'opencode']) {
      store.setChatLink(foreignChatKey(providerId, FOREIGN_GROUP), {
        parentChatId: 'parent',
        groupIndex: 1,
        branch: 'feature/b',
        createdAt: at,
      });
    }
    events = [];
    registry = new ChatRunRegistry(liveRun);
    session = new ChatSession(registry);
    ctx = {
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
    await app.ready();
    deliverAhead = false;
    wireForeignShellJudge({
      ctx,
      store,
      providerChats: { setShellJudge: (set) => void (judge = set) },
      deliverAhead: () => deliverAhead,
    });
    startRun(GROUP, copyA);
    startRun(PLAIN, copyA);
  });

  afterEach(async () => {
    for (const detach of detaches.splice(0)) detach();
    registry.stopAll();
    await app.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  // Строки погашения читают снимок процессов ОС (~1 с на чтение) — таблице нужно время.
  it('группа: каждый провод — ответ маршрута Claude', { timeout: 120_000 }, async () => {
    const seen = new Set<Outcome>();
    for (const row of GROUP_ROWS) {
      for (const wire of WIRES) {
        if (!wire.tools.includes(row.tool)) continue;
        const want = await reference(GROUP, row.command, wire.tools);
        const got = await foreign(wire, FOREIGN_GROUP, copyB, row.command);
        seen.add(want);
        expect(`${wire.name}: ${row.command} → ${got}`).toBe(
          `${wire.name}: ${row.command} → ${want}`,
        );
      }
    }
    // Таблица не вырождена: в ней есть и «само», и D-n, и известный отказ.
    expect([...seen].sort()).toEqual(expect.arrayContaining(['allow', 'deferred', 'refused']));
  });

  it('одиночный чат, правки включены: каждый провод — ответ авторежима Claude', async () => {
    armed.set(PLAIN, { enabled: true, allowEdits: true });
    session.armAutoApprove(PLAIN, armed.get(PLAIN)!);
    const seen = new Set<Outcome>();
    for (const row of CHAT_ROWS) {
      for (const wire of WIRES) {
        if (!wire.tools.includes(row.tool)) continue;
        const want = await reference(PLAIN, row.command, wire.tools);
        const got = await foreign(wire, FOREIGN_CHAT, copyA, row.command);
        seen.add(want);
        expect(`${wire.name}: ${row.command} → ${got}`).toBe(
          `${wire.name}: ${row.command} → ${want}`,
        );
      }
    }
    // Тумблер Claude пускает и пуш в main (его останавливает `deny` CLI, не панель) —
    // у чужого то же; в таблице есть и «само», и карточка.
    expect([...seen].sort()).toEqual(expect.arrayContaining(['allow', 'card']));
  });

  it('звено до доставки: пуш и MR — отказ у обоих, коммит — сам', async () => {
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
    startRun(GROUP, copyA);
    deliverAhead = true;
    for (const command of ['git push origin HEAD', 'gh pr create --fill', 'git commit -m "x"']) {
      for (const wire of WIRES) {
        const want = await reference(GROUP, command, wire.tools);
        const got = await foreign(wire, FOREIGN_GROUP, copyB, command);
        expect(`${wire.name}: ${command} → ${got}`).toBe(`${wire.name}: ${command} → ${want}`);
      }
    }
    expect(await reference(GROUP, 'git push origin HEAD', ['Bash'])).toBe('deny');
  });

  it('D-n группы: «разрешить» человека пропускает ровно этот вызов один раз', async () => {
    const wire = WIRES[0]!;
    const command = 'git branch -D other';
    expect(await foreign(wire, FOREIGN_GROUP, copyB, command)).toBe('deferred');
    const id = deferredIdOf(lastForeignMessage);
    expect(id).toBeTruthy();
    // Тот же вызов снова, пока человек молчит, — та же запись, не вторая.
    expect(await foreign(wire, FOREIGN_GROUP, copyB, command)).toBe('deferred');
    expect(deferredIdOf(lastForeignMessage)).toBe(id);
    expect(deferredAsksOf(ctx).decide(id!, { behavior: 'allow', via: 'web' })).toBeTruthy();
    // «Разрешить» — ровно этот вызов, один раз; ветка жива до него.
    expect(await foreign(wire, FOREIGN_GROUP, copyB, 'git branch -D old')).toBe('deferred');
    expect(await foreign(wire, FOREIGN_GROUP, copyB, command)).toBe('allow');
    expect(await foreign(wire, FOREIGN_GROUP, copyB, command)).toBe('deferred');
    expect(deferredIdOf(lastForeignMessage)).not.toBe(id);
  });

  /**
   * Погашение своего (P-06): корень дерева — процесс CLI хода, его номер едет с
   * просьбой (`answerCodexApproval(…, pid)`). CLI здесь — сам процесс теста, свой
   * процесс — его ребёнок. Без номера своё не доказать — отказ агенту, как у Claude.
   */
  it('погашение: ребёнок процесса CLI хода — сам, без номера CLI — отказ агенту (P-06)', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
    });
    try {
      expect(child.pid).toBeTruthy();
      // Номера гасимого разбор знает у Bash (`kill`); `Stop-Process` инструментом
      // PowerShell целей не называет — и у Claude, и здесь это D-n (строка таблицы).
      const command = `kill ${child.pid}`;
      const codexAsk = async (pid: number | undefined) => {
        let verdict: LiveShellJudgement | undefined;
        const policy: LivePermissionPolicy = {
          allowEdits: true,
          ask: async () => 'deny',
          judge: async (shell, cliPid) => {
            verdict = await judge({
              providerId: 'codex',
              chatId: FOREIGN_GROUP,
              workdir: copyB,
              allowEdits: true,
              ...(cliPid ? { pid: cliPid } : {}),
              shell,
            });
            return verdict;
          },
        };
        const answer = (await answerCodexApproval(
          {
            jsonrpc: '2.0',
            id: 9,
            method: 'item/commandExecution/requestApproval',
            params: {
              command: `/bin/bash -lc ${shQuote(command)}`,
              cwd: '.',
              itemId: 'i9',
            },
          } as never,
          policy,
          pid,
        )) as { decision: string };
        return { decision: answer.decision, verdict };
      };
      const own = await codexAsk(process.pid);
      expect(own.verdict).toEqual({ behavior: 'allow' });
      expect(own.decision).toBe('accept');
      const blind = await codexAsk(undefined);
      expect(blind.decision).toBe('decline');
      const message = blind.verdict?.behavior === 'deny' ? (blind.verdict.message ?? '') : '';
      expect(deferredIdOf(message)).toBeFalsy();
      expect(message).toContain('did not start');
    } finally {
      child.kill();
    }
  });

  it('D-n группы: «запретить» человека — отказ с его словами, не новая запись', async () => {
    const wire = WIRES.find((one) => one.name === 'qwen posix')!;
    const command = 'psql -c "drop table users"';
    expect(await foreign(wire, FOREIGN_GROUP, copyB, command)).toBe('deferred');
    const id = deferredIdOf(lastForeignMessage)!;
    deferredAsksOf(ctx).decide(id, { behavior: 'deny', message: 'базу не трогать', via: 'web' });
    expect(await foreign(wire, FOREIGN_GROUP, copyB, command)).toBe('deferred');
    expect(lastForeignMessage).toContain('базу не трогать');
    expect(deferredIdOf(lastForeignMessage)).toBe(id);
  });

  /**
   * Состояние MR знает только фордж — заглушка GitLab на свободном порту; читает
   * его та же функция маршрута (`withMrState`), что у Claude.
   */
  it('MR ветки: черновик — перезапись сама, на ревью — отказ у обоих', async () => {
    let draft = true;
    const forge = createServer((req, res) => {
      const iid = /\/merge_requests\/(\d+)/.exec(req.url ?? '')?.[1];
      if (!iid) {
        res.writeHead(404).end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          iid: Number(iid),
          title: 'Группа',
          state: 'opened',
          draft,
          source_branch: iid === '1' ? 'feature/a' : 'feature/b',
          target_branch: 'main',
          web_url: `${site}/team/repo/-/merge_requests/${iid}`,
        }),
      );
    });
    await new Promise<void>((done) => forge.listen(0, '127.0.0.1', done));
    const site = `http://127.0.0.1:${(forge.address() as AddressInfo).port}`;
    try {
      const plan = store.getSplitPlan('parent') as SplitPlanRecord;
      store.setSplitPlan({
        ...plan,
        groups: plan.groups.map((group) => ({
          ...group,
          mr: `${site}/team/repo/-/merge_requests/${group.index + 1}`,
        })),
      } as SplitPlanRecord);
      writeSettings(store, 'gitlab', { enabled: true, baseUrl: site, repo: '' });
      writeToken(join(root, 'agentdeck'), 'gitlab', 'stub-key');
      const lease = 'git push --force-with-lease origin HEAD';
      for (const [state, expected] of [
        [true, 'allow'],
        [false, 'deny'],
      ] as const) {
        draft = state;
        for (const wire of WIRES) {
          const want = await reference(GROUP, lease, wire.tools);
          const got = await foreign(wire, FOREIGN_GROUP, copyB, lease);
          expect(`${wire.name}: draft=${state} → ${got}`).toBe(
            `${wire.name}: draft=${state} → ${want}`,
          );
        }
        expect(await reference(GROUP, lease, ['Bash'])).toBe(expected);
      }
      expect(lastForeignMessage).toContain('rewriting the branch');
    } finally {
      forge.closeAllConnections();
      await new Promise<void>((done) => forge.close(() => done()));
    }
  });

  it('строка cmd (оболочка не названа): `rd /s` — человеку, `rm -rf` судят чтения', async () => {
    const qwenWin = WIRES.find((wire) => wire.name === 'qwen win32 (оболочка не названа)')!;
    const codexCmd: Wire = {
      name: 'codex cmd /c',
      providerId: 'codex',
      tools: ['Bash', 'PowerShell'],
      decide: codexWire((command) => `C:\\Windows\\System32\\cmd.exe /c ${command}`),
    };
    for (const wire of [qwenWin, codexCmd]) {
      for (const command of [
        'rd /s /q src',
        'del /s /q *.ts',
        'cd src && rmdir /S /Q build',
        'erase /s /q docs',
        'del /f /s /q dist',
        'RD /S src',
      ]) {
        expect(
          `${wire.name}: ${command} → ${await foreign(wire, FOREIGN_GROUP, copyB, command)}`,
        ).toBe(`${wire.name}: ${command} → deferred`);
      }
      expect(await foreign(wire, FOREIGN_GROUP, copyB, 'rm -rf dist')).toBe(
        await reference(GROUP, 'rm -rf dist', wire.tools),
      );
      expect(await foreign(wire, FOREIGN_GROUP, copyB, 'dir /s')).toBe('allow');
    }
  });

  it('правило `ask` самого CLI (P-05): совпадение — человеку, хотя правки включены', async () => {
    writeFileSync(
      join(root, 'qwen-home', 'settings.json'),
      JSON.stringify({ permissions: { ask: ['Bash(pnpm lint *)'] } }),
    );
    writeFileSync(
      join(root, 'opencode.json'),
      JSON.stringify({ permission: { bash: { 'pnpm lint *': 'ask', '*': 'allow' } } }),
    );
    const qwen = WIRES.find((wire) => wire.name === 'qwen posix')!;
    const opencode = WIRES.find((wire) => wire.name === 'opencode posix')!;
    const codex = WIRES.find((wire) => wire.name === 'codex posix (bash -lc)')!;
    expect(await foreign(qwen, FOREIGN_CHAT, copyA, 'pnpm lint --fix')).toBe('card');
    expect(await foreign(opencode, FOREIGN_CHAT, copyA, 'pnpm lint --fix')).toBe('card');
    expect(await foreign(qwen, FOREIGN_CHAT, copyA, 'pnpm build')).toBe('allow');
    // У codex правил команд нет — его ответ не меняется.
    expect(await foreign(codex, FOREIGN_CHAT, copyA, 'pnpm lint --fix')).toBe('allow');
    // В группе то же правило — D-n, а не «само».
    expect(await foreign(qwen, FOREIGN_GROUP, copyB, 'pnpm lint --fix')).toBe('deferred');
  });
});
