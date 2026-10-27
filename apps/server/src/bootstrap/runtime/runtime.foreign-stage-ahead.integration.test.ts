import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { foreignChatKey } from '@agentdeck/contracts/foreign-chat-key';
import { AppStore } from '../../lib/app-store/app-store.ts';
import type { ServerContext } from '../../context.ts';
import type { ChatLink, SplitPlanRecord } from '../../lib/app-store/app-store.types.ts';
import type {
  ProviderChatRunLike,
  ProviderChatRunOptions,
} from '../../domains/provider-chat/ProviderChatRun/ProviderChatRun.ts';
import { createChat, type ProviderChatCascade } from '../../domains/provider-chat/store/store.ts';
import { getProvider } from '../../providers/registry.ts';
import { removeWhenFree } from '../../lib/remove-when-free.ts';
import { createRuntime, type Runtime } from './runtime.ts';

/**
 * P-39: звено группы чужого CLI с первого хода знает, что за ним, — та же строка
 * `aheadNote`, что звено Claude получает в системном промпте (`groupRunProfile`). Без
 * неё рабочее звено узнавало о доставке впереди только отказом пуша
 * (`PUBLISH_BEFORE_DELIVERY_DENIED`) и тратило ход. Сборка настоящая (`createRuntime`:
 * `setChildRun` → `childStageNote`, `ProviderChatService`, системный канал Qwen Code);
 * подменён только прогон CLI — он записывает то, с чем CLI был бы запущен.
 */

const PARENT = 'родитель-p39';
const HEAD = 'Later stages of this chain:';
const REVIEW = 'a review stage in a fresh session of this CLI reads this work';
const DELIVER = 'a delivery stage pushes the branch and opens the MR';

describe('звено группы чужого CLI — строка «что за звеном» (P-39)', () => {
  let root: string;
  let appData: string;
  let project: string;
  let store: AppStore;
  let runtime: Runtime;
  let runs: ProviderChatRunOptions[];
  let savedQwenHome: string | undefined;

  beforeEach(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-rt-p39-')));
    appData = join(root, 'agentdeck');
    project = join(root, 'project');
    mkdirSync(appData, { recursive: true });
    mkdirSync(project);
    writeFileSync(join(root, 'settings.json'), '{}', 'utf8');
    writeFileSync(join(root, '.claude.json'), '{}', 'utf8');
    mkdirSync(join(root, 'qwen-home'));
    writeFileSync(join(root, 'qwen-home', 'settings.json'), '{}', 'utf8');
    savedQwenHome = process.env.QWEN_HOME;
    process.env.QWEN_HOME = join(root, 'qwen-home');
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
    // Прогон CLI — внешняя граница: вход записан, ответ «Готово.».
    (runtime.providerChats as unknown as { createRun: () => ProviderChatRunLike }).createRun =
      () => ({
        start: (options, onEvent) => {
          runs.push(options);
          onEvent({ type: 'done', reply: 'Готово.', transport: 'stream' });
          return Promise.resolve();
        },
        stop: () => undefined,
      });
  });

  afterEach(async () => {
    if (savedQwenHome === undefined) delete process.env.QWEN_HOME;
    else process.env.QWEN_HOME = savedQwenHome;
    runtime.chatRuns.stopAll();
    runtime.shutdown();
    await removeWhenFree(root);
  });

  const settle = () => new Promise((done) => setTimeout(done, 100));

  /**
   * Первый ход звена: шапка разговора `cascade`, связь `patch`, доставка у группы
   * `deliver`. Ответ — всё, что дошло до CLI: реплики хода и системная строка Qwen
   * Code (файл `QWEN.md` каталогов `includeDirectories` слоя системных настроек).
   */
  async function firstTurn(
    providerId: string,
    cascade: ProviderChatCascade | undefined,
    patch: Partial<ChatLink>,
    deliver: boolean,
  ): Promise<{ reply: string; system: string }> {
    const chat = createChat(appData, providerId, {
      title: 'G',
      workdir: project,
      ...(cascade ? { cascade } : {}),
    });
    const key = foreignChatKey(providerId, chat!.id);
    store.setSplitPlan({
      parentChatId: PARENT,
      projectPath: project,
      createdAt: '2026-10-27T00:00:00.000Z',
      order: [0],
      request: {},
      proposal: { groups: [{ title: 'G', tasks: ['PROJ-1 поправить подпись'] }] },
      groups: [
        {
          index: 0,
          title: 'G',
          branch: 'feature/g1',
          after: [],
          status: 'started',
          chatId: key,
          path: project,
          ...(deliver ? { deliver: true } : {}),
        },
      ],
    } as unknown as SplitPlanRecord);
    store.setChatLink(key, {
      parentChatId: PARENT,
      groupIndex: 0,
      branch: 'feature/g1',
      createdAt: '2026-10-27T01:00:00.000Z',
      ...patch,
    });
    const before = runs.length;
    const sent = runtime.providerChats.send(
      appData,
      providerId,
      chat!.id,
      { text: 'Сделай задачу группы' },
      { provider: getProvider(providerId), models: [] },
    );
    expect(sent.ok).toBe(true);
    await settle();
    const run = runs[before];
    expect(run).toBeDefined();
    const reply = run!.history.at(-1)?.content ?? '';
    const settingsPath = (run!.platformEnv ?? {}).QWEN_CODE_SYSTEM_SETTINGS_PATH;
    let system = '';
    if (settingsPath && existsSync(settingsPath)) {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
        context?: { includeDirectories?: string[] };
      };
      for (const dir of settings.context?.includeDirectories ?? []) {
        const file = join(dir, 'QWEN.md');
        if (existsSync(file)) system += readFileSync(file, 'utf8');
      }
    }
    return { reply, system };
  }

  it('codex: работа со шапкой при доставке впереди — ревью и доставка в первом ходе', async () => {
    const { reply } = await firstTurn(
      'codex',
      { stage: 'work', group: 'G' },
      { stage: 'work' },
      true,
    );
    expect(reply).toContain(HEAD);
    expect(reply).toContain(REVIEW);
    expect(reply).toContain(DELIVER);
    // Обещания «модель сильнее прочтёт» у чужого CLI нет: потолка у него нет.
    expect(reply).not.toContain('ceiling model');
  });

  it('qwen: строка едет системным каналом, не в реплике человека', async () => {
    const { reply, system } = await firstTurn(
      'qwen',
      { stage: 'work', group: 'G' },
      { stage: 'work' },
      true,
    );
    expect(system).toContain(HEAD);
    expect(system).toContain(REVIEW);
    expect(system).toContain(DELIVER);
    expect(reply).not.toContain(HEAD);
  });

  it('codex: впереди ничего — строки нет', async () => {
    // Доставка — конец цепочки.
    const deliver = await firstTurn(
      'codex',
      { stage: 'deliver', group: 'G' },
      { stage: 'deliver' },
      true,
    );
    expect(deliver.reply).not.toContain(HEAD);
    // Ревью после работы выключено, доставки у группы нет.
    const bare = await firstTurn(
      'codex',
      { stage: 'work', group: 'G', reviewAfterWork: false },
      { stage: 'work', reviewAfterWork: false },
      false,
    );
    expect(bare.reply).not.toContain(HEAD);
  });

  it('codex: без шапки ревью не заводится — в строке только доставка', async () => {
    const { reply } = await firstTurn('codex', undefined, {}, true);
    expect(reply).toContain(DELIVER);
    expect(reply).not.toContain(REVIEW);
  });

  it('codex: правки со списком замечаний — впереди проход проверки, ревью уже заведено — нет', async () => {
    const fix = await firstTurn(
      'codex',
      { stage: 'fix', group: 'G', fixFindings: ['🟡 F-1'] },
      { stage: 'fix', fixFindings: ['🟡 F-1'] },
      false,
    );
    expect(fix.reply).toContain(REVIEW);
    const reviewed = await firstTurn(
      'codex',
      { stage: 'work', group: 'G', reviewedAt: '2026-10-27T02:00:00.000Z' },
      { stage: 'work' },
      false,
    );
    expect(reviewed.reply).not.toContain(HEAD);
  });
});
