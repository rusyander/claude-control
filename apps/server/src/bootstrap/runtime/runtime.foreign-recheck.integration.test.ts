import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { taskCoverageLine } from '@agentdeck/contracts/quality-floor';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type {
  ProviderChatRunLike,
  ProviderChatRunOptions,
} from '../../domains/provider-chat/ProviderChatRun/ProviderChatRun.ts';
import { createChat } from '../../domains/provider-chat/store/store.ts';
import { completenessFacts } from '../../domains/chat/handoff-coverage/handoff-coverage.ts';
import { recheckPrompt } from '../../domains/chat/split-recheck/split-recheck.ts';
import { readRecheckScope } from '../../domains/chat/split-recheck/recheck-session.ts';
import { deliveryGapLines } from '../../domains/chat/split-conveyor/split-conveyor.ts';
import { removeWhenFree } from '../../lib/remove-when-free.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * P-28 (паритет): «Перепроверить MR» у группы чужого CLI. Задание перепроверки
 * собирается до выбора CLI (`recheckDeliveredMr` → `completenessFacts`), а у
 * чужого CLI идёт продолжением его разговора (`createRecheckSession` → прежний
 * путь → `startForeignReviewStage`). Здесь доказано, что до CLI доходит ровно
 * то задание, что у группы Claude: шаг полноты со следом задач, пункты, которые
 * соседи отдали этой группе, и её отданные пункты без владельца; и что след
 * задач (`taskTrace`) группе поставлен — доставка после хода потребует `task-N`.
 * Сборка настоящая (`createRuntime`), подменён только прогон CLI.
 */

const PARENT = 'родитель-p28';
const MR = 'https://git.example.com/team/repo/-/merge_requests/41';

describe('перепроверка MR группы чужого CLI — то же задание полноты (P-28)', () => {
  let root: string;
  let appData: string;
  let project: string;
  let store: AppStore;
  let runtime: Runtime;
  let runs: ProviderChatRunOptions[];
  /** Ответить на ход: CLI кончил его этим текстом. */
  let answers: ((reply: string) => void)[];

  beforeEach(() => {
    answers = [];
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-p28-')));
    appData = join(root, 'agentdeck');
    project = join(root, 'project');
    mkdirSync(appData, { recursive: true });
    mkdirSync(project);
    // Копия группы — настоящий git: проверка доставки после хода читает её.
    const git = (args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: project });
    git(['init', '-q', '-b', 'main']);
    git(['commit', '-q', '--allow-empty', '-m', 'init']);
    git(['checkout', '-q', '-b', 'feature/menu']);
    writeFileSync(join(project, 'menu.txt'), 'menu\n');
    git(['add', 'menu.txt']);
    git(['commit', '-q', '-m', 'feat: menu']);
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    writeFileSync(join(root, '.claude.json'), '{}', 'utf8');
    store = new AppStore(appData);
    const ctx = {
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
    runs = [];
    // Прогон CLI — внешняя граница: задание записано, ход «в работе» (ответа нет).
    (runtime.providerChats as unknown as { createRun: () => ProviderChatRunLike }).createRun =
      () => ({
        start: (options, onEvent) => {
          runs.push(options);
          return new Promise<void>((done) => {
            answers.push((reply) => {
              onEvent({ type: 'done', reply, transport: 'stream' });
              done();
            });
          });
        },
        stop: () => undefined,
      });
  });

  afterEach(async () => {
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    await removeWhenFree(root);
  });

  const settle = () => new Promise((done) => setTimeout(done, 100));

  for (const providerId of ['codex', 'qwen'] as const) {
    it(`${providerId}: задание с шагом полноты, отданными пунктами и следом задач`, async () => {
      const chat = createChat(appData, providerId, { title: 'Меню', workdir: project });
      const key = foreignChatKey(providerId, chat!.id);
      store.setSplitPlan({
        parentChatId: PARENT,
        projectPath: project,
        createdAt: '2026-10-26T00:00:00.000Z',
        order: [0, 1],
        request: {},
        proposal: {
          groups: [
            { title: 'Меню', tasks: ['PROJ-1 подпись меню'], owns: ['src/menu/'] },
            { title: 'Админка', tasks: ['PROJ-2 таблица админки'], owns: ['src/admin/'] },
          ],
        },
        groups: [
          {
            index: 0,
            title: 'Меню',
            branch: 'feature/menu',
            base: 'main',
            after: [],
            status: 'done',
            deliver: true,
            mr: MR,
            chatId: key,
            path: project,
            // Свой пункт, отданный «группе 2» без пути из её списка, — пробел самой группы.
            sieveRows: [
              { id: 'task-1', status: 'n/a', evidence: 'out of scope — group 2 does it' },
            ],
          },
          {
            index: 1,
            title: 'Админка',
            branch: 'feature/admin',
            after: [],
            status: 'started',
            chatId: 'claude-admin',
            path: join(root, 'admin'),
            // Сосед отдал пункт этой группе.
            sieveRows: [
              { id: 'task-2', status: 'n/a', evidence: 'other group: group 1 owns the menu label' },
            ],
          },
        ],
      } as unknown as SplitPlanRecord);
      store.setChatLink(key, {
        parentChatId: PARENT,
        groupIndex: 0,
        branch: 'feature/menu',
        stage: 'deliver',
        createdAt: '2026-10-26T01:00:00.000Z',
      });
      const facts = completenessFacts(store.getSplitPlan(PARENT)!, 0);
      // Не вырождено: списки шага полноты не пусты.
      expect(facts.incomingRows.length).toBeGreaterThan(0);
      expect(facts.deferrals.length).toBeGreaterThan(0);
      const scope = await readRecheckScope({ mainDir: project, copy: project, base: 'main' });
      expect(scope?.files).toEqual(['menu.txt']);
      const expected = recheckPrompt({
        branch: 'feature/menu',
        mr: MR,
        ...(scope ? { scope } : {}),
        completeness: facts,
      });

      const result = await runtime.recheckMr(PARENT, 0);
      await settle();

      expect(result.outcome).toBe('sent');
      const run = runs.at(-1);
      expect(run, 'CLI не запущен').toBeDefined();
      const asked = [...(run?.history ?? [])].reverse().find((m) => m.role === 'user')?.content;
      // Ровно то задание, что получила бы группа Claude (после строки ветки и задач).
      expect(asked).toContain(expected);
      expect(asked).toContain(taskCoverageLine());
      for (const line of [...facts.incomingRows, ...facts.deferrals, ...facts.siblings]) {
        expect(asked).toContain(line);
      }
      // Новый разговор не заводится: чужой CLI продолжает свой (recheck-session.ts).
      expect(Object.keys(store.getChatLinks()).some((k) => k.startsWith('new-'))).toBe(false);
      // След задач поставлен: доставка после хода требует строки task-N.
      expect(store.getSplitPlan(PARENT)!.groups[0]!.taskTrace).toBe(true);

      // Ответ CLI с отчётом task-N доходит до записи группы тем же концом цепочки
      // (`chainOutcomeOf` → `onChainEnded`), и общий список пробелов доставки
      // (`deliveryGapLines`, его же зовёт проверка после хода) называет «fail».
      const sieves = {
        sieves: [{ id: 'task-1', status: 'fail', evidence: 'menu label not done' }],
      };
      answers.at(-1)?.(
        `Completeness: task-1 still open.\n\`\`\`agentdeck:sieves\n${JSON.stringify(sieves)}\n\`\`\`\n${MR}`,
      );
      const rowOf = () =>
        store.getSplitPlan(PARENT)!.groups[0]!.sieveRows?.find((r) => r.id === 'task-1');
      for (let i = 0; i < 50 && rowOf()?.status !== 'fail'; i += 1) await settle();
      expect(rowOf()?.status, 'отчёт CLI не дошёл до группы').toBe('fail');
      const record = store.getSplitPlan(PARENT)!;
      const gaps = deliveryGapLines({ missing: [] }, record.groups[0]!, record);
      expect(gaps.some((line) => line.includes('task-1'))).toBe(true);
    });
  }
});
