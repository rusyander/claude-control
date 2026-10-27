import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readChats } from '../../chat/ChatHistory/ChatHistory.ts';
import { buildInbox } from '../../chat/chat-inbox/chat-inbox.ts';
import { createTranscriptTailReader } from '../../chat/chat-inbox/transcript-tail.ts';
import { QUESTION_DENIED } from '../../chat/initiative/initiative.ts';
import { applyAnswer, type Inject } from './apply.ts';
import { collectPendingAsks } from './collect.ts';
import { TelegramAnswersService } from './service.ts';
import { AnswersStore } from './store.ts';

/**
 * Живой прогон владельца 25.10: в обычном чате панели агент спросил
 * `AskUserQuestion`, брокер отказал (`QUESTION_DENIED`), ход кончился, вопрос
 * висит карточкой. Весь путь на настоящих частях, кроме Bot API: транскрипт в
 * том виде, что пишет CLI → хвост транскрипта → сводка → ожидание ответов →
 * сообщение с вариантами кнопками → нажатие → ответ тем же маршрутом
 * (`POST /api/chat/send`), что у карточки в панели.
 */

const TOKEN = '123456789:AAHfakefakefakefakefakefakefakefake';
const OWNER = '4242';
const SESSION = '0f0e0d0c-1111-4222-8333-444455556666';

function transcript(at: string): string {
  const base = { sessionId: SESSION, cwd: '/w/shop', version: '2.1.295', entrypoint: 'sdk-cli' };
  const records = [
    {
      ...base,
      type: 'user',
      uuid: 'u1',
      timestamp: at,
      message: { role: 'user', content: 'Почисти доску задач' },
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'a1',
      timestamp: at,
      message: {
        role: 'assistant',
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_card_1',
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: 'Перевести три задачи из Review дальше?',
                  header: 'Jira',
                  options: [{ label: 'Да, перевести' }, { label: 'Нет' }],
                },
              ],
            },
          },
        ],
      },
    },
    {
      ...base,
      type: 'user',
      uuid: 'u2',
      timestamp: at,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_card_1',
            content: QUESTION_DENIED,
            is_error: true,
          },
        ],
      },
    },
    {
      ...base,
      type: 'assistant',
      uuid: 'a2',
      timestamp: at,
      message: {
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Жду ответа по карточке.' }],
      },
    },
    { ...base, type: 'system', subtype: 'stop_hook_summary', timestamp: at },
  ];
  return records.map((record) => JSON.stringify(record)).join('\n') + '\n';
}

describe('вопрос-карточка законченного хода — в Telegram с вариантами', () => {
  let root: string | undefined;
  let service: TelegramAnswersService | undefined;
  afterEach(() => {
    service?.stop();
    vi.unstubAllGlobals();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('сводка видит вопрос, сообщение несёт проект, чат, вопрос и кнопки, нажатие уходит в чат', async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-tg-card-'));
    const projects = join(root, 'projects');
    mkdirSync(join(projects, '-w-shop'), { recursive: true });
    const now = Date.now();
    const at = new Date(now - 60_000).toISOString();
    writeFileSync(join(projects, '-w-shop', `${SESSION}.jsonl`), transcript(at));

    const tail = createTranscriptTailReader(() => projects);
    const collect = async () =>
      collectPendingAsks({
        inbox: buildInbox({
          chats: readChats(projects),
          runs: [],
          permissions: [],
          lastAsked: (chatId) => tail(chatId)?.asked,
          clientOf: (chatId) => tail(chatId)?.client,
          now,
        }),
        foreign: [],
        defaultCli: 'Claude Code',
        cliName: (id) => id,
      });
    const items = await collect();
    expect(items).toHaveLength(1);
    expect(items[0]!.target).toMatchObject({ kind: 'question', chatId: SESSION });

    const calls: { method: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const method = String(url).split('/').pop()!;
        const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
        calls.push({ method, body });
        const ok = (result: unknown) =>
          new Response(JSON.stringify({ ok: true, result }), { status: 200 });
        if (method === 'getMe') return ok({ id: 123456789, username: 'deck_bot' });
        if (method === 'getWebhookInfo') return ok({ url: '' });
        if (method === 'getUpdates') {
          return new Promise<Response>((_, reject) =>
            init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          );
        }
        if (method === 'sendMessage') return ok({ message_id: 77, chat: { id: Number(OWNER) } });
        return ok(true);
      }),
    );
    const sent: Parameters<Inject>[0][] = [];
    const inject: Inject = async (request) => {
      sent.push(request);
      return { statusCode: 200, body: '{}' };
    };
    const store = new AnswersStore();
    store.setSettings({ enabled: true, afterMinutes: 0, ownerId: OWNER, ownerName: '' });
    service = new TelegramAnswersService({
      store,
      // Тишина после старта (B7) проверяется отдельно, в telegram-batch.test.ts.
      sendGraceMs: 0,
      token: () => TOKEN,
      agentBotIds: () => new Set(),
      collect,
      apply: (target, answer, clientId) =>
        applyAnswer(target, answer, { inject, clientId, runParams: () => undefined }),
      vanished: () => ({ kind: 'inPanel' }),
      log: () => undefined,
      scanMs: 3_600_000,
    });
    await service.restart();
    await service.scan();

    const message = calls.find((call) => call.method === 'sendMessage')!;
    const text = String(message.body.text);
    expect(text).toContain('<b>❓ ВОПРОС · 📁 shop · Почисти доску задач</b>');
    expect(text).toContain('<b>Перевести три задачи из Review дальше?</b>');
    const buttons = (
      message.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
    ).inline_keyboard.flat();
    expect(buttons.map((button) => button.text)).toEqual([
      '1. Да, перевести',
      '2. Нет',
      '✍️ Свой ответ',
    ]);

    await service.handleUpdate({
      update_id: 1,
      callback_query: {
        id: 'cb',
        from: { id: Number(OWNER) },
        data: buttons[0]!.callback_data,
        message: { message_id: 77, chat: { id: Number(OWNER) } },
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: 'POST',
      url: '/api/chat/send',
      payload: {
        chatId: SESSION,
        sessionId: SESSION,
        prompt: 'Да, перевести',
        projectPath: '/w/shop',
      },
    });
  });
});
