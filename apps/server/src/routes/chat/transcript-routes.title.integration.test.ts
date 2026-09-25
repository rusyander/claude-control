import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatSummary } from '@agentdeck/contracts';
import { buildGroupPrompt, environmentPreamble } from '@agentdeck/contracts/task-split';
import { reviewStagePrompt } from '@agentdeck/contracts/model-cascade';
import { workAfterPlanPrompt } from '@agentdeck/contracts/split-plan';
import { AppStore } from '../../lib/app-store.ts';
import type { ServerContext } from '../../context.ts';
import { registerChatTranscriptRoutes } from './transcript-routes.ts';
import { groupIdentityLine } from '../../domains/chat/split-conveyor.ts';
import { planStagePrompt } from '@agentdeck/contracts/split-plan';
import { buildHandoffPrompt } from '@agentdeck/contracts/chat-handoff';

/**
 * Название чата группы в списке (живой стенд 25.09.2026): звено, чья первая
 * реплика целиком написана панелью, называлось её преамбулой. Теперь такое
 * звено называется именем группы из связи — и у живой связи, и у снятой
 * перезапуском групп (`retireChatLink`): снятая больше не теряет имя группы.
 * Маршрут настоящий, транскрипты — настоящие файлы на диске.
 */
describe('GET /api/chats — название звена группы', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;
  let project: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-chat-title-'));
    mkdirSync(join(root, 'agentdeck'), { recursive: true });
    project = join(root, 'work');
    mkdirSync(project, { recursive: true });
    store = new AppStore(join(root, 'agentdeck'));
    const ctx = {
      store,
      location: { paths: { root, appData: join(root, 'agentdeck') } },
      pricing: { current: () => ({ entries: [] }) },
    } as unknown as ServerContext;
    app = Fastify();
    registerChatTranscriptRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  function transcript(chatId: string, prompt: string, ...later: string[]): void {
    const dir = join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    const lines = [prompt, ...later].map((content, index) =>
      JSON.stringify({
        type: 'user',
        uuid: `u-${chatId}-${index}`,
        sessionId: chatId,
        cwd: project,
        timestamp: `2026-09-25T10:0${index}:00.000Z`,
        message: { role: 'user', content },
      }),
    );
    writeFileSync(join(dir, `${chatId}.jsonl`), `${lines.join('\n')}\n`);
  }

  const link = (title: string) => ({
    parentChatId: 'parent-1',
    title,
    groupIndex: 0,
    createdAt: '2026-09-25T10:00:00.000Z',
  });

  async function list(): Promise<Map<string, ChatSummary>> {
    const response = await app.inject({ method: 'GET', url: '/api/chats' });
    expect(response.statusCode).toBe(200);
    const chats = response.json<ChatSummary[]>();
    return new Map(chats.map((chat) => [chat.id, chat]));
  }

  const REVIEW = reviewStagePrompt({
    task: 'Поправь вход',
    model: 'claude-opus-4-8',
    branch: 'fix/login',
  });

  it('звено, написанное панелью целиком, называется именем группы', async () => {
    transcript('review-1', REVIEW);
    store.setChatLink('review-1', link('Форма входа'));

    const chat = (await list()).get('review-1');

    expect(chat?.title).toBe('Форма входа');
    expect(chat?.groupTitle).toBe('Форма входа');
  });

  it('звено с заданием после преамбулы называется заданием, а не группой', async () => {
    transcript(
      'work-1',
      `${environmentPreamble({ mirror: 'Локальный слой: перенесено 235' })}\n\n${buildGroupPrompt({
        title: 'Форма входа',
        branch: 'fix/login',
        tasks: ['Поправь валидацию формы входа'],
      })}`,
    );
    store.setChatLink('work-1', link('Форма входа'));

    expect((await list()).get('work-1')?.title).toBe('Поправь валидацию формы входа');
  });

  // Живой прогон 25.09.2026 (D8): работа после плана начиналась строкой ветки
  // группы, и список с карточкой вопроса у родителя звали чат «Ветка группы:
  // fix/capitalize. Панель подготовила…». Реплика собрана панелью целиком.
  it('работа после плана (строка ветки первой) называется именем группы', async () => {
    const task = `${environmentPreamble({ mirror: 'Локальный слой: перенесено 235' })}

${buildGroupPrompt({
  title: 'Форма входа',
  branch: 'fix/login',
  tasks: ['Поправь валидацию формы входа'],
})}`;
    transcript(
      'work-2',
      `${groupIdentityLine('fix/login', ['PROJ-7'])}

${workAfterPlanPrompt({ task })}`,
    );
    store.setChatLink('work-2', { ...link('Форма входа'), stage: 'work' });

    const chat = (await list()).get('work-2');

    expect(chat?.title).toBe('Форма входа');
    expect(chat?.title).not.toContain('Ветка группы');
  });

  // Живой прогон 26.09 (D8): звено, открытое репликой панели, называлось
  // следующей репликой — ответом человека на вопрос группы.
  it('ответ человека после реплики панели — не название, чат зовётся группой', async () => {
    transcript('review-2', REVIEW, 'Локальный репозиторий');
    store.setChatLink('review-2', link('Форма входа'));

    expect((await list()).get('review-2')?.title).toBe('Форма входа');
  });

  it('звено плана называется именем группы, а не «План работы для группы…»', async () => {
    transcript(
      'plan-1',
      planStagePrompt({ title: 'Форма входа', task: 'Поправь вход', branch: 'fix/login' }),
    );
    store.setChatLink('plan-1', { ...link('Форма входа'), stage: 'plan' });

    const chat = (await list()).get('plan-1');

    expect(chat?.title).toBe('Форма входа');
    expect(chat?.title).not.toContain('План работы');
  });

  it('снятое перезапуском звено держит имя группы и называется им', async () => {
    transcript('old-1', REVIEW);
    store.setChatLink('old-1', link('Форма входа'));
    store.retireChatLink('old-1');

    const chat = (await list()).get('old-1');

    expect(chat).toMatchObject({ parentId: 'parent-1', retired: true });
    expect(chat?.groupTitle).toBe('Форма входа');
    expect(chat?.title).toBe('Форма входа');
    // Группой снятое звено по-прежнему не числится: номера группы у него нет.
    expect(chat?.groupIndex).toBeUndefined();
  });

  // Живой прогон 25.09.2026: абзац доставки с тех пор дописали, а чаты групп,
  // заведённые накануне, хранят прежний текст и назывались «Доставка до
  // готового MR — обязанность этой группы…».
  it('абзац доставки в прежней редакции — не название, чат зовётся заданием', async () => {
    transcript(
      'deliver-old',
      `${environmentPreamble({ mirror: 'Локальный слой: перенесено 234' })}\n\n` +
        'Доставка до готового MR — обязанность этой группы: человек включил её на проекте, и это его ' +
        'разрешение на коммит, пуш и MR.\nПроведи задачи группы по навыку доставки.\n\n' +
        buildGroupPrompt({
          title: 'Форма входа',
          branch: 'fix/login',
          tasks: ['Поправь валидацию формы входа'],
        }),
    );
    store.setChatLink('deliver-old', link('Форма входа'));

    const title = (await list()).get('deliver-old')?.title;

    expect(title).toBe('Поправь валидацию формы входа');
  });

  it('продолжение группы в чистой сессии называется именем группы', async () => {
    transcript(
      'handoff-1',
      buildHandoffPrompt(
        { done: 'сделано', next: 'дальше', checkpoint: '.agent/PROGRESS.md' },
        'Поправь валидацию формы входа',
        { group: true },
      ),
    );
    store.setChatLink('handoff-1', link('Форма входа'));

    const title = (await list()).get('handoff-1')?.title;

    expect(title).toBe('Форма входа');
  });

  it('чат без связи с одной преамбулой — как раньше, имя проекта', async () => {
    transcript('plain-1', REVIEW);

    const chat = (await list()).get('plain-1');

    expect(chat?.title).toBe('proj');
  });
});
