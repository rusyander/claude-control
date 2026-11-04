import { join } from 'node:path';
import { ownsJsonlTranscript } from '../transcript-owner.ts';
import { qwenHome } from './read-layer.ts';

/**
 * Разговор Qwen Code, начатый не ядром, — этого корня (этап 10, F2; `CliAdapter.ownsTranscript`).
 * Хранилище — `<QWEN_HOME | ~/.qwen>/projects/<проект>/chats/<id>.jsonl` (тот же разбор, что у
 * сканера аналитики панели), строки несут `{sessionId, cwd}`. Id разговора CLI — UUID, который
 * CLI принимает (`--session-id`/`--resume`); иная форма — не имя файла, а попытка его подобрать.
 * Относительный дом CLI достроит от СВОЕГО cwd — ядро его не угадывает: `undefined`.
 */
const QWEN_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function qwenOwnsTranscript(
  pin: Record<string, string>,
  root: string,
  conversationId: string,
): boolean | undefined {
  if (!QWEN_SESSION_ID.test(conversationId)) return false;
  const home = qwenHome(pin);
  if (!home.absolute) return undefined;
  return ownsJsonlTranscript(join(home.path, 'projects'), 'chats', root, conversationId);
}
