// Одна «жизнь ядра» живой проверки возобновления Qwen: свой процесс, свой экземпляр переходника
// (память прежнего процесса недоступна, как после перезапуска ядра). Настройка — base64url JSON
// в argv[2]; итог — JSON одной строкой в stdout. Сеанс: запуск → одна отправка → конец хода →
// остановка деревом.
import { join } from 'node:path';
import type { AdapterEvent } from '../../adapter.types.ts';
import {
  EventTap,
  HOOK_LOG,
  liveSpec,
  type LiveRoot,
} from '../../conformance/__fixtures__/live.ts';
import { createQwenAdapter, QWEN_CHANNELS } from '../qwen.ts';

export interface ResumeChildConfig {
  live: LiveRoot;
  sessionId: string;
  resume?: string;
  message: string;
  baseUrl: string;
  /** Бриф шага (нет — бриф стенда). */
  brief?: string;
}

export interface ResumeChildResult {
  launched: boolean;
  reason?: string;
  conversationId?: string;
  text?: string;
  argv?: string[];
  seen: string[];
}

const raw = process.argv[2];
if (!raw) throw new Error('usage: resume-child.ts <base64url config>');
const cfg = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as ResumeChildConfig;

const channel = QWEN_CHANNELS.find((c) => c.dialect === 'openai-chat');
if (!channel) throw new Error('no openai-chat channel');
const adapter = createQwenAdapter();
const spec = liveSpec(cfg.live, {
  sessionId: cfg.sessionId,
  dir: join(cfg.live.sessions, cfg.sessionId),
  endpoint: {
    channel,
    endpoint: { baseUrl: cfg.baseUrl, dialect: 'openai-chat', model: 'stub-model', key: 'k' },
  },
  ...(cfg.resume ? { resume: { conversationId: cfg.resume } } : {}),
  // Хук ядра обязателен (F-10): живой CLI его исполняет — подставной хук пишет и разрешает.
  coreHook: `node ${HOOK_LOG} core --log ${cfg.live.logs.core}`,
  ...(cfg.brief ? { brief: cfg.brief } : {}),
});

const result: ResumeChildResult = { launched: false, seen: [] };
const launched = await adapter.launch(spec);
if (!launched.ok) {
  result.reason = launched.reason;
} else {
  result.launched = true;
  result.argv = launched.handle.spawned.argv;
  const tap = new EventTap(adapter, launched.handle);
  try {
    await adapter.send(launched.handle, cfg.message, crypto.randomUUID());
    const ended = await tap.until((e) => e.type === 'turn.ended', 90_000);
    result.text = (ended as Extract<AdapterEvent, { type: 'turn.ended' }>).text;
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
  }
  const init = tap.seen.find((e) => e.type === 'init');
  if (init?.type === 'init') result.conversationId = init.conversationId;
  result.seen = tap.seen.map((e) => e.type);
  await adapter.stop(launched.handle, 'tree');
}
process.stdout.write(`${JSON.stringify(result)}\n`);
