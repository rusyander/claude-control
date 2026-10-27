import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { RunOptions } from '../../domains/chat/ChatRunner/ChatRunner.ts';
import type { RunMeta } from '../../domains/chat/ChatRunRegistry/ChatRunRegistry.types.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import { removeWhenFree } from '../../lib/remove-when-free.ts';
import {
  decideDeferred,
  deferredAsksOf,
} from '../../routes/chat/deferred-routes/deferred-store.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * Слово панели об исходе D-n не убивает фоновых агентов разговора (split d9869abf, F1).
 *
 * Было: оркестратор ревью кончил ход, держа шесть полос-субагентов в живом процессе
 * CLI. Повторный суд панели отказал D-8 и сказал это группе продолжением её сессии;
 * продолжение шло с другой подписью запуска, пул закрыл прежний процесс — и девять
 * агентов умерли недоделанными. Сборка настоящая (`createRuntime`): решение →
 * `deferred-wiring` → `resumeGroup` → `ChildTells` → запуск продолжения → реестр →
 * пул живых процессов. Подменён только CLI (`fake-live-cli.mjs`, режим BGASK:
 * субагент `local_agent` живёт до появления файла, потом CLI просыпается сам).
 */

const FAKE = fileURLToPath(
  new URL('../../domains/chat/__fixtures__/fake-live-cli.mjs', import.meta.url),
);
const COMMAND = process.platform === 'win32' ? `"${process.execPath}" "${FAKE}"` : FAKE;
const PARENT = 'родитель-f1';
const SESSION = 'live-session-0001';

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('не дождались');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe(
  'слово об исходе D-n ждёт конца фоновых агентов (F1, d9869abf)',
  { timeout: 60_000 },
  () => {
    let root: string;
    let project: string;
    let release: string;
    let store: AppStore;
    let ctx: ServerContext;
    let runtime: Runtime;
    let prompts: string[];
    let pids: number[];

    beforeEach(() => {
      root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-agents-')));
      const appData = join(root, 'agentdeck');
      project = join(root, 'project');
      release = join(root, 'agents-done');
      mkdirSync(appData, { recursive: true });
      mkdirSync(project);
      execSync('git init -q -b main', { cwd: project, stdio: 'ignore' });
      execSync('git -c user.email=p@x -c user.name=p commit -q --allow-empty -m base', {
        cwd: project,
        stdio: 'ignore',
      });
      writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
      writeFileSync(join(root, '.claude.json'), '{}', 'utf8');
      store = new AppStore(appData);
      ctx = {
        store,
        location: {
          paths: {
            root,
            appData,
            settings: join(root, 'settings.json'),
            settingsLocal: join(root, 'settings.local.json'),
            claudeMd: join(root, 'CLAUDE.md'),
            secretsEnv: join(root, '.mcp-secrets.env'),
            skills: join(root, 'skills'),
            hooks: join(root, 'hooks'),
            mcpConfig: join(root, '.claude.json'),
          },
        },
        backupDir: join(root, 'backups'),
        pricing: { current: () => ({ entries: [] }) },
        models: { current: () => ({ models: [] }) },
      } as unknown as ServerContext;
      runtime = createRuntime(ctx, 'http://127.0.0.1:1');
      prompts = [];
      pids = [];
      // Процесс CLI — поддельный; карточка прав не нужна (ключ панели не трогаем).
      const start = runtime.chatRuns.start.bind(runtime.chatRuns);
      runtime.chatRuns.start = (chatId: string, options: RunOptions, meta: RunMeta) => {
        const { permissionPrompt: _card, ...rest } = options;
        if (options.prompt) prompts.push(options.prompt);
        return start(chatId, { ...rest, command: COMMAND }, meta);
      };
    });

    afterEach(async () => {
      writeFileSync(release, 'done');
      runtime.chatRuns.stopAll();
      runtime.chatRuns.livePool.closeAll();
      runtime.shutdown();
      for (const pid of pids) if (isAlive(pid)) process.kill(pid);
      await removeWhenFree(root);
    });

    function textOf(chatId: string): string {
      const seen: string[] = [];
      runtime.chatRuns.attach(chatId, 0, {
        send: (buffered) => {
          if (buffered.event.kind === 'text') seen.push(buffered.event.text);
        },
        close: () => {},
      });
      return seen.join('');
    }

    /** Ревью группы кончило ход, держа субагента в живом процессе. */
    async function reviewHoldingAgent(): Promise<number> {
      store.setChatLink(SESSION, {
        parentChatId: PARENT,
        groupIndex: 0,
        branch: 'feature/g1',
        stage: 'review',
        createdAt: '2026-10-26T01:00:00.000Z',
      });
      store.setSplitPlan({
        parentChatId: PARENT,
        projectPath: project,
        createdAt: '2026-10-26T00:00:00.000Z',
        order: [0],
        request: {},
        proposal: { groups: [{ title: 'G', tasks: ['PROJ-1'] }] },
        groups: [
          {
            index: 0,
            title: 'G',
            branch: 'feature/g1',
            after: [],
            status: 'started',
            chatId: SESSION,
            path: project,
            deliver: true,
          },
        ],
      } as unknown as SplitPlanRecord);
      expect(
        runtime.chatRuns.start(
          SESSION,
          { prompt: `BGASK ${release}`, cwd: project, command: COMMAND },
          { origin: 'groups', projectPath: project },
        ),
      ).toBe(true);
      await waitFor(() => /turn 1 pid \d+/.test(textOf(SESSION)));
      await waitFor(() => !runtime.chatRuns.isRunning(SESSION));
      const pid = Number(/turn 1 pid (\d+)/.exec(textOf(SESSION))?.[1]);
      pids.push(pid);
      // Транскрипт разговора: продолжение ищет его, чтобы продолжить ту же сессию.
      const transcripts = join(root, 'projects', 'p');
      mkdirSync(transcripts, { recursive: true });
      writeFileSync(
        join(transcripts, `${SESSION}.jsonl`),
        `${JSON.stringify({ type: 'user', sessionId: SESSION, cwd: project, message: { role: 'user', content: 'review' } })}\n`,
      );
      return pid;
    }

    async function refuseByPanel(): Promise<string> {
      const asked = deferredAsksOf(ctx).ask({
        scope: { kind: 'group', parentChatId: PARENT, groupIndex: 0 },
        runKeys: [SESSION],
        toolName: 'Bash',
        input: { command: 'pnpm content:check' },
        reason: 'test',
        cwd: project,
      });
      const id = asked.record.id;
      await decideDeferred(ctx, id, {
        behavior: 'deny',
        message: 'the call is not needed',
        via: 'auto',
      });
      return id;
    }

    it('отказ панели не закрывает процесс с идущим субагентом; слово уходит после его конца', async () => {
      const pid = await reviewHoldingAgent();
      expect(runtime.chatRuns.liveAgentsOf(SESSION)).toBe(1);

      const id = await refuseByPanel();
      await pause(1_500);

      // Красное до правки: продолжение с другой подписью закрыло процесс вместе с агентом.
      expect(isAlive(pid)).toBe(true);
      expect(prompts.some((prompt) => prompt.includes(id))).toBe(false);

      // Агент доделал работу, CLI проснулся сам в том же процессе — и только теперь слово.
      writeFileSync(release, 'done');
      await waitFor(() => textOf(SESSION).includes(`woke pid ${pid}`), 20_000);
      await waitFor(() => prompts.some((prompt) => prompt.includes(id)), 20_000);
      expect(prompts.find((prompt) => prompt.includes(id))).toContain(
        `The panel re-checked ${id} and refused it`,
      );
    });

    it('слово группе в звене доставки по-прежнему говорит о черновике MR', async () => {
      await reviewHoldingAgent();
      const link = store.getChatLink(SESSION)!;
      store.setChatLink(SESSION, { ...link, stage: 'deliver' });
      writeFileSync(release, 'done');
      await waitFor(() => runtime.chatRuns.liveAgentsOf(SESSION) === 0);
      await waitFor(() => !runtime.chatRuns.isRunning(SESSION));

      const id = await refuseByPanel();

      await waitFor(() => prompts.some((prompt) => prompt.includes(id)), 20_000);
      expect(prompts.find((prompt) => prompt.includes(id))).toContain('take the MR out of draft');
    });
  },
);
