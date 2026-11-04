import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterEvent, StreamNormaliser } from '../adapter.types.ts';
import type { RpcDialect } from './rpc.types.ts';

/**
 * Вид сеанса CLI JSON-RPC по stdio (этап 10, `GET …/sessions/:sid/stream`): повтор `stdout.log`
 * идёт через СВЕЖИЙ диалект того же переходника — тот же разбор, что у живого насоса
 * (`rpc-session.ts`), второго разборщика нет. Диалект нумерует свои запросы и узнаёт конец хода по
 * id ответа, поэтому повтор обязан звать его в том же порядке, что и насос: `start()` до первой
 * строки, `turn()` на смещении отправки из `core-io.jsonl` (`expect`).
 *
 * Разбор зависит от входа запуска (команда хука Codex, `session/load` продолжения, режим права):
 * переходник кладёт этот вход в `rpc-view.json` каталога сеанса ДО запуска CLI, повтор строит
 * диалект из него. Значения, которые разбор не читает (бриф, env и заголовки серверов MCP),
 * на диск не ложатся — их вычищает `viewInput` переходника.
 */

export const RPC_VIEW = 'rpc-view.json';

/** Вход диалекта для вида; файла нет — сеанс запущен до того, как вход стал записываться. */
export function readRpcViewInput<I>(dir: string): I {
  const path = join(dir, RPC_VIEW);
  if (!existsSync(path)) {
    throw new NoSessionView(
      `${RPC_VIEW} is absent: the session started before the core recorded its view input`,
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as I;
}

/** Вида у сеанса нет по названной причине (не сбой чтения): маршрут отвечает 501 `no-view`. */
export class NoSessionView extends Error {
  override name = 'NoSessionView';
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Текст хода из записанной строки запроса: блоки `text` из `params.input` (Codex `turn/start`)
 * или `params.prompt` (ACP `session/prompt`). Иная строка — как есть: человек видит, что ушло.
 */
export function rpcTurnText(data: string): string {
  try {
    const msg = JSON.parse(data) as unknown;
    const params = isRecord(msg) && isRecord(msg.params) ? msg.params : {};
    const blocks = Array.isArray(params.input)
      ? params.input
      : Array.isArray(params.prompt)
        ? params.prompt
        : null;
    if (blocks) {
      return (blocks as unknown[])
        .map((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
        .join('');
    }
  } catch {
    // Не JSON — показываем строку как есть.
  }
  return data;
}

/** Нормализатор вида над свежим диалектом: порядок вызовов — как у насоса сеанса. */
export function createRpcNormaliser(dialect: RpcDialect): StreamNormaliser {
  // Рукопожатие насос начинает в конструкторе, до чтения вывода: тот же первый id запроса.
  dialect.start();
  return {
    expect(cmdId, uuid) {
      // Текст хода разбору не нужен (он только в строке stdin); id запроса и ожидание эха — нужны.
      dialect.turn('', cmdId, uuid);
    },
    push(line): AdapterEvent[] {
      return dialect.push(line).events;
    },
    turnText: rpcTurnText,
  };
}
