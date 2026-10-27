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
import { MAIN_SYNC_DENIED } from '../../domains/chat/main-sync/main-sync.ts';
import { writeRun } from '../../domains/project-tests/runs-store/runs-store.ts';
import type { ProjectTestRunRecord } from '@agentdeck/contracts';
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
import { rejudgeGroupAsk, staleFolderOfAsk } from '../deferred-wiring/rejudge.ts';

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
  let lastClaudeMessage = '';
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
      lastClaudeMessage = settled.message;
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
      // Номера гасимого разбор знает и у Bash (`kill`), и у PowerShell
      // (`Stop-Process -Id`, Q2 24.10): оба провода судятся одинаково.
      const bash = `/bin/bash -lc ${shQuote(`kill ${child.pid}`)}`;
      const pwsh = `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command ${psQuote(
        `Stop-Process -Id ${child.pid} -Force`,
      )}`;
      const codexAsk = async (pid: number | undefined, command = bash) => {
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
              command,
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
      // PowerShell-провод: своё — само, без номера CLI — отказ агенту, не D-n.
      const ownPs = await codexAsk(process.pid, pwsh);
      expect(ownPs.verdict).toEqual({ behavior: 'allow' });
      const blindPs = await codexAsk(undefined, pwsh);
      expect(blindPs.decision).toBe('decline');
      const psMessage = blindPs.verdict?.behavior === 'deny' ? (blindPs.verdict.message ?? '') : '';
      expect(deferredIdOf(psMessage)).toBeFalsy();
      expect(psMessage).toContain('did not start');
    } finally {
      child.kill();
    }
  });

  // D33 у чужого CLI: посреди перебазирования на main сторона main для файла —
  // разрешение конфликта, как у маршрута Claude; новый догон сверяется по-прежнему.
  it('D33: сторона целевой посреди идущего догона — сама и у чужого CLI', async () => {
    const wire = WIRES.find((one) => one.name === 'codex posix (bash -lc)')!;
    const g = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd: copyB,
        stdio: 'ignore',
      });
    };
    g('checkout', '-q', '-b', 'mainline');
    writeFileSync(join(copyB, 'a.txt'), 'theirs\n');
    g('add', 'a.txt');
    g('commit', '-qm', 'main side');
    g('update-ref', 'refs/remotes/origin/main', 'HEAD');
    g('checkout', '-q', 'feature/b');
    writeFileSync(join(copyB, 'a.txt'), 'ours\n');
    g('add', 'a.txt');
    g('commit', '-qm', 'own side');
    expect(() => g('rebase', 'origin/main')).toThrow();
    const restore = 'git show origin/main:a.txt > a.txt';
    expect(await foreign(wire, FOREIGN_GROUP, copyB, restore)).toBe('allow');
    expect(await foreign(wire, FOREIGN_GROUP, copyB, 'git merge origin/main')).toBe('deny');
    g('rebase', '--abort');
    expect(await foreign(wire, FOREIGN_GROUP, copyB, restore)).toBe('deny');
  });

  /**
   * Догон на целевую (P-17, I-40): пропускается ровно при НАСТОЯЩЕМ конфликте с
   * вершиной сервера. git 2.55 `merge-tree --quiet` выходит с 0 и при конфликте —
   * так g0 25.10 получал отказ, хотя конфликт был. Сервер здесь — голый репозиторий
   * `origin`: `serverConflicts` сверяет его вершину, не `origin/*` копии.
   */
  it(
    'догон на main: без конфликта — отказ, при конфликте — сам, у каждого провода как у Claude (P-17)',
    { timeout: 120_000 },
    async () => {
      const project = join(root, 'repo');
      const remote = join(root, 'origin.git');
      const g = (cwd: string, ...args: string[]): void => {
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
          cwd,
          stdio: 'ignore',
        });
      };
      const commit = (cwd: string, file: string, text: string, message: string): void => {
        writeFileSync(join(cwd, file), text);
        g(cwd, 'add', file);
        g(cwd, 'commit', '-qm', message);
      };
      g(root, 'init', '-q', '--bare', '-b', 'main', remote);
      g(project, 'remote', 'add', 'origin', remote);
      // Свой файл у каждой ветки, у main — третий: конфликта нет.
      commit(copyA, 'a-own.txt', 'a\n', 'feature a');
      commit(copyB, 'b-own.txt', 'b\n', 'feature b');
      commit(project, 'main-only.txt', 'm\n', 'main moved');
      g(project, 'push', '-q', 'origin', 'main');
      g(project, 'fetch', '-q', 'origin');
      const sync = 'git rebase origin/main';
      for (const wire of WIRES) {
        const want = await reference(GROUP, sync, wire.tools);
        const got = await foreign(wire, FOREIGN_GROUP, copyB, sync);
        expect(`${wire.name}: без конфликта → ${got}`).toBe(
          `${wire.name}: без конфликта → ${want}`,
        );
        expect(got).toBe('deny');
        expect(lastForeignMessage).toBe(MAIN_SYNC_DENIED);
      }
      // Один файл, разное содержимое у main и у обеих веток: настоящий конфликт.
      commit(copyA, 'shared.txt', 'ours a\n', 'feature a shared');
      commit(copyB, 'shared.txt', 'ours b\n', 'feature b shared');
      commit(project, 'shared.txt', 'theirs\n', 'main shared');
      g(project, 'push', '-q', 'origin', 'main');
      g(project, 'fetch', '-q', 'origin');
      for (const wire of WIRES) {
        const want = await reference(GROUP, sync, wire.tools);
        const got = await foreign(wire, FOREIGN_GROUP, copyB, sync);
        expect(`${wire.name}: конфликт → ${got}`).toBe(`${wire.name}: конфликт → ${want}`);
        expect(got).toBe('allow');
      }
    },
  );

  /**
   * #g0:111 (25.10): после своего перебазирования g0 клал чистый main рядом, чтобы
   * прогнать на нём красные тесты, и получал MAIN_SYNC_DENIED. HEAD уже содержит
   * `origin/main` — выгрузка ничего ветке не несёт; целевая ушла вперёд — снова догон.
   */
  it(
    'дерево целевой рядом: HEAD её содержит — само, ушла вперёд — отказ, у каждого провода как у Claude (#g0:111)',
    { timeout: 120_000 },
    async () => {
      const project = join(root, 'repo');
      const remote = join(root, 'origin.git');
      const g = (cwd: string, ...args: string[]): void => {
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
          cwd,
          stdio: 'ignore',
        });
      };
      const commit = (cwd: string, file: string, text: string, message: string): void => {
        writeFileSync(join(cwd, file), text);
        g(cwd, 'add', file);
        g(cwd, 'commit', '-qm', message);
      };
      g(root, 'init', '-q', '--bare', '-b', 'main', remote);
      g(project, 'remote', 'add', 'origin', remote);
      g(project, 'push', '-q', 'origin', 'main');
      g(project, 'fetch', '-q', 'origin');
      commit(copyA, 'a-own.txt', 'a\n', 'feature a');
      commit(copyB, 'b-own.txt', 'b\n', 'feature b');
      // Форма, одинаковая для оболочек: в PowerShell `>/dev/null` — запись в файл вне копии.
      const tree = 'git worktree add --detach .agent/tmp/main-wt origin/main';
      // Вызов g0 целиком (Bash): дерево рядом, тесты в нём.
      const live =
        `${tree} >/dev/null 2>&1; cd .agent/tmp/main-wt/api && ` +
        'GOFLAGS=-mod=mod go test ./internal/ws 2>&1 | grep -E "^(--- FAIL|FAIL|ok)"';
      for (const wire of WIRES) {
        const want = await reference(GROUP, tree, wire.tools);
        const got = await foreign(wire, FOREIGN_GROUP, copyB, tree);
        expect(`${wire.name}: в HEAD → ${got}`).toBe(`${wire.name}: в HEAD → ${want}`);
        expect(got).toBe('allow');
      }
      expect(await claude(GROUP, live, 'Bash')).toBe('allow');
      commit(project, 'main-only.txt', 'm\n', 'main moved');
      g(project, 'push', '-q', 'origin', 'main');
      g(project, 'fetch', '-q', 'origin');
      // F-09: отказ дереву целевой называет разрешённый путь — `run --base` с красными
      // кейсами копии из её последнего прогона; записей нет — образец вместо списка.
      writeRun(copyB, {
        id: 'run-red',
        mode: 'import',
        actor: 'ci',
        status: 'done',
        startedAt: '2026-10-25T13:50:00.000Z',
        results: [
          {
            pointId: 'p1',
            groupId: 'suites-inst-api',
            caseId: 'suites-inst-api-007',
            status: 'failed',
          },
          {
            pointId: 'p2',
            groupId: 'suites-inst-api',
            caseId: 'suites-inst-api-014',
            status: 'failed',
          },
          {
            pointId: 'p3',
            groupId: 'suites-inst-api',
            caseId: 'suites-inst-api-001',
            status: 'passed',
          },
        ],
        summary: { total: 3, passed: 1, failed: 2, blocked: 0, skipped: 0, unknown: 0 },
      } as ProjectTestRunRecord);
      const sanctioned = (cases: string) =>
        new RegExp(
          `^${MAIN_SYNC_DENIED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} .*\`node "[^"]+tests-cli\\.mjs" run --project \\. --case ${cases} --base\``,
        );
      for (const wire of WIRES) {
        const want = await reference(GROUP, tree, wire.tools);
        expect(lastClaudeMessage).toMatch(sanctioned('<group:case,group:case>'));
        const got = await foreign(wire, FOREIGN_GROUP, copyB, tree);
        expect(`${wire.name}: впереди → ${got}`).toBe(`${wire.name}: впереди → ${want}`);
        expect(got).toBe('deny');
        expect(lastForeignMessage).toMatch(
          sanctioned('suites-inst-api:suites-inst-api-007,suites-inst-api:suites-inst-api-014'),
        );
      }
      expect(await claude(GROUP, live, 'Bash')).toBe('deny');
      expect(lastClaudeMessage).toMatch(sanctioned('<group:case,group:case>'));
    },
  );

  it('Stop-Process инструментом PowerShell у Claude судится как kill у Bash, не D-n (Q2)', async () => {
    const bash = await reference(GROUP, `kill ${process.pid}`, ['Bash']);
    const ps = await reference(GROUP, `Stop-Process -Id ${process.pid} -Force`, ['PowerShell']);
    expect(ps).not.toBe('deferred');
    expect(ps).toBe(bash);
    // Имя образа — «неназванное»: отказ агенту с подсказкой, тоже не D-n.
    expect(await reference(GROUP, 'Stop-Process -Name node -Force', ['PowerShell'])).not.toBe(
      'deferred',
    );
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
  // Два состояния MR × каждый провод × два суда с настоящим git: 13 с в одиночку, под нагрузкой
  // зоны — за 20 с по умолчанию (27.10), как у соседей с git — свой предел.
  it(
    'MR ветки: черновик — перезапись сама, на ревью — отказ у обоих',
    { timeout: 120_000 },
    async () => {
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
    },
  );

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

  /**
   * P-26: точка соединения `cmd //c mklink //J` (D-7/D-12) — у чужого CLI тот же
   * суд, что у Claude: ссылка в своей копии на каталог копии — сама, ссылка вне
   * копии — человеку. Пути абсолютные: корень оболочки у обоих судей свой.
   */
  it('mklink //J (P-26): своя ссылка — сама, ссылка вне копии — человеку, у всех проводов', async () => {
    const slash = (path: string): string => path.replace(/\\/g, '/');
    const own = (copy: string): string =>
      `cmd //c mklink //J "${slash(join(copy, '.agent', 'tmp', 'nm'))}" "${slash(join(copy, 'node_modules'))}"`;
    const outside = (copy: string): string =>
      `cmd //c mklink //J "${slash(join(root, 'elsewhere', 'nm'))}" "${slash(join(copy, 'node_modules'))}"`;
    // Не вырождено: у Claude чтение Bash даёт и «само», и D-n.
    expect(await reference(GROUP, own(copyA), ['Bash'])).toBe('allow');
    expect(await reference(GROUP, outside(copyA), ['Bash'])).toBe('deferred');
    for (const wire of WIRES) {
      for (const [label, make] of [
        ['own', own],
        ['outside', outside],
      ] as const) {
        const want = await reference(GROUP, make(copyA), wire.tools);
        const got = await foreign(wire, FOREIGN_GROUP, copyB, make(copyB));
        expect(`${wire.name}: ${label} → ${got}`).toBe(`${wire.name}: ${label} → ${want}`);
      }
    }
  });

  /**
   * P-26 (F7/D-5): D-n чужого CLI ждёт, а папки, куда шёл `cd`, уже нет — обход
   * и пересуд отказывают агенту, как записи Claude. Транскрипта Claude у чужого
   * CLI нет: каталог оболочки, от которого судили вживую, едет в самой записи.
   */
  it('D-n чужого CLI: папка `cd` убрана — обход и пересуд отказывают (P-26)', async () => {
    const shellCwd = join(copyB, '.agent', 'tmp', 'rev');
    const clone = join(shellCwd, 'clone');
    const far = join(root, 'elsewhere', 'clone');
    mkdirSync(clone, { recursive: true });
    mkdirSync(far, { recursive: true });
    const projectsDir = join(root, 'projects');
    mkdirSync(projectsDir, { recursive: true });
    const ask = async (command: string) => {
      const verdict = await judge({
        providerId: 'qwen',
        chatId: FOREIGN_GROUP,
        workdir: copyB,
        allowEdits: true,
        shell: { command, shell: 'bash', cwd: shellCwd },
      });
      const id = deferredIdOf(verdict.behavior === 'deny' ? (verdict.message ?? '') : '');
      expect(id, `${command}: не D-n`).toBeDefined();
      return deferredAsksOf(ctx).get(id!)!;
    };
    const relative = await ask('cd clone && psql -c "drop table users"');
    const absolute = await ask(`cd "${far.replace(/\\/g, '/')}" && psql -c "drop table users"`);
    // Папки на месте — запись по-прежнему человеку.
    expect(staleFolderOfAsk(relative, { source: store, projectsDir })).toBeUndefined();
    rmSync(clone, { recursive: true, force: true });
    rmSync(far, { recursive: true, force: true });
    for (const [record, gone] of [
      [relative, clone],
      [absolute, far],
    ] as const) {
      const swept = staleFolderOfAsk(record, { source: store, projectsDir });
      expect(swept?.behavior).toBe('deny');
      const norm = (text: string | undefined) => (text ?? '').replace(/\\/g, '/').toLowerCase();
      expect(norm(swept?.message)).toContain(norm(gone));
      const rejudged = await rejudgeGroupAsk(record, {
        source: store,
        projectsDir,
        guardedPatterns: () => [],
        allowedTools: () => new Set(),
        guarded: () => false,
      });
      expect(rejudged?.behavior).toBe('deny');
      expect(norm(rejudged?.message)).toContain(norm(gone));
    }
    expect(relative.shellCwd).toBe(shellCwd);
  });

  /**
   * P-26 (D-10/D-11): группа сняла копию `cp f /tmp/x.bak` и убирает её `rm /tmp/x.bak` — у Claude
   * улика своего — транскрипт (`run-routes.group-cwd-kill` «D-10»: своё — само, чужое — D-n). У Codex и
   * Qwen Code транскрипта Claude нет; улика — журнал сессии набора (`call` PreToolUse + `ran`
   * PostToolUse), сессия — id, что провод несёт в просьбе (`threadId` Codex) или транспорт открыл до
   * хода (поток Codex, сессия qwen serve). Состояние набора — временный `AGENTDECK_KIT_STATE`.
   */
  it('D-10: уборка своей копии в `/tmp` у Codex и Qwen Code — сама; без своего `cp` — D-n (P-26)', async () => {
    saved.AGENTDECK_KIT_STATE = process.env.AGENTDECK_KIT_STATE;
    process.env.AGENTDECK_KIT_STATE = join(root, 'kit-state');
    const sessions = join(root, 'kit-state', 'sessions');
    mkdirSync(sessions, { recursive: true });
    const stem = `fp${process.pid}${Math.random().toString(36).slice(2, 8)}`;
    const own = join(tmpdir(), `${stem}-c.bak`);
    const other = join(tmpdir(), `${stem}-f.bak`);
    const late = join(tmpdir(), `${stem}-l.bak`);
    // Журнал набора: `cp` пропущен и исполнен; второй `cp` пропущен, но не исполнен (нет `ran`).
    const kitLog = (session: string, atMs: number) =>
      writeFileSync(
        join(sessions, `${session}.jsonl`),
        `${[
          {
            ts: atMs - 5_000,
            kind: 'call',
            tool: 'Bash',
            key: 'k1',
            cmd: `cp package.json /tmp/${stem}-c.bak`,
          },
          { ts: atMs + 5_000, kind: 'ran', tool: 'Bash', key: 'k1' },
          // Пропущен в ту же секунду, что файл записан: окно записи накрыло бы его, будь вызов исполнен.
          {
            ts: atMs,
            kind: 'call',
            tool: 'Bash',
            key: 'k2',
            cmd: `cp package.json /tmp/${stem}-l.bak`,
          },
        ]
          .map((event) => JSON.stringify(event))
          .join('\n')}\n`,
      );
    /** Судья через провод CLI: `session` — то, что провод/транспорт отдали просьбе. */
    const judged = async (
      providerId: 'codex' | 'qwen',
      command: string,
      wire: { threadId?: string; thread?: string; session?: string },
    ): Promise<Outcome> => {
      let verdict: LiveShellJudgement | undefined;
      const policy: LivePermissionPolicy = {
        allowEdits: true,
        ask: async () => 'deny',
        judge: async (shell, pid, session) => {
          verdict = await judge({
            providerId,
            chatId: FOREIGN_GROUP,
            workdir: copyB,
            allowEdits: true,
            ...(pid ? { pid } : {}),
            ...(session ? { session } : {}),
            shell,
          });
          return verdict;
        },
      };
      if (providerId === 'codex') {
        await answerCodexApproval(
          {
            jsonrpc: '2.0',
            id: 9,
            method: 'item/commandExecution/requestApproval',
            params: {
              command: `/bin/bash -lc ${shQuote(command)}`,
              cwd: copyB,
              itemId: 'i9',
              ...(wire.threadId ? { threadId: wire.threadId } : {}),
            },
          } as never,
          policy,
          undefined,
          wire.thread,
        );
      } else {
        const shell = qwenShellAsk(
          { _meta: { toolName: 'run_shell_command' }, rawInput: { command }, kind: 'execute' },
          'linux',
        );
        await decidePermission(policy, {
          cli: 'qwen',
          requestId: 'r9',
          tool: 'execute',
          ...(shell ? { shell } : {}),
          ...(wire.session ? { session: wire.session } : {}),
        });
      }
      expect(verdict).toBeDefined();
      if (verdict?.behavior === 'allow') return 'allow';
      return classify('deny', verdict?.behavior === 'deny' ? (verdict.message ?? '') : '');
    };
    try {
      for (const path of [own, other, late]) writeFileSync(path, 'backup');
      const atMs = Date.now();
      // Codex: id сессии хука — поток; Qwen Code: `config.getSessionId()` (регистр не важен, ACP).
      kitLog('019a-codex-thread-p26', atMs);
      kitLog('5f0c-qwen-session-p26', atMs);
      const cases = [
        ['codex', { threadId: '019a-codex-thread-p26' }],
        ['codex', { thread: '019a-codex-thread-p26' }],
        ['qwen', { session: '5F0C-QWEN-SESSION-P26' }],
      ] as const;
      for (const [providerId, wire] of cases) {
        const label = `${providerId} ${JSON.stringify(wire)}`;
        expect(await judged(providerId, `rm /tmp/${stem}-c.bak`, wire), label).toBe('allow');
        expect(await judged(providerId, `rm /tmp/${stem}-*.bak`, wire), label).toBe('deferred');
        expect(await judged(providerId, `rm /tmp/${stem}-f.bak`, wire), label).toBe('deferred');
        // `cp` без `ran` — не исполнен: улики нет.
        expect(await judged(providerId, `rm /tmp/${stem}-l.bak`, wire), label).toBe('deferred');
      }
      // Сессия не названа или чужая — улики нет, как без транскрипта у Claude.
      expect(await judged('qwen', `rm /tmp/${stem}-c.bak`, {})).toBe('deferred');
      expect(await judged('codex', `rm /tmp/${stem}-c.bak`, { threadId: 'other-thread' })).toBe(
        'deferred',
      );
    } finally {
      for (const path of [own, other, late]) rmSync(path, { force: true });
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
