import type { AskSession } from '@agentdeck/contracts/core/ask';
import type { ForeignCarryResolver } from '../chat/core-foreign/foreign-carry.ts';
import { TESTS_NOTE_VAR } from '../chat/core-run/session-carry.ts';
import type { AskCarry } from './core-ask.types.ts';

/**
 * Набор панели окну помощника формы и структуры (этап 10, G13). Прежнее окно давало процессу
 * чужого CLI окружение набора этого CLI (`route.kit.env`, HEAD `assistant-route.ts`): дом Qwen
 * в режиме «Наши», файл правил Codex. Теперь ход — сессия ядра «ask», и набор едет тем же
 * переносом, что у разговора чужого CLI (`createForeignCarry`, G6): имена переменных и дописка
 * (правила Codex текстом) — в `fields.session`, значения — вне полей. Ядро судит имена тем же
 * судом, что у сеанса чата (`envNamesProblems`).
 *
 * Claude-помощнику набор не шёл и не идёт: окно Claude запускалось без него. Каталога у окна нет —
 * строки о тестах тоже нет (метка `AGENTDECK_TESTS_NOTE` снята: хуков у вопроса нет вовсе).
 * Чего сессия «ask» не берёт (плагины, сужения инструментов и источников), отказано по имени —
 * лучше отказ человеку, чем ход, тихо ушедший без части набора.
 */

/** CLI, у окна которого набора не было (`kind: 'claude'` прежнего маршрута окна). */
const NO_KIT_CLI = 'claude';

export function helperCarryOf(foreign: ForeignCarryResolver): AskCarry {
  return ({ cli, routes }) => {
    if (cli === NO_KIT_CLI) return { ok: true };
    const carried = foreign({ cli, cwd: '', ...(routes ? { routes } : {}) });
    if (!carried.ok) return carried;
    const { append, env: names, ...rest } = carried.carry.session;
    const extra = Object.keys(rest);
    if (extra.length > 0) {
      return {
        ok: false,
        reason: `the panel kit for ${cli} needs ${extra.join(', ')}, a helper question takes only rules text and environment`,
      };
    }
    const kept = (names ?? []).filter((name) => name !== TESTS_NOTE_VAR);
    const env = Object.fromEntries(kept.map((name) => [name, carried.carry.env[name] ?? '']));
    const session: AskSession = {
      ...(append ? { append } : {}),
      ...(kept.length > 0 ? { env: kept } : {}),
    };
    if (!session.append && !session.env) return { ok: true };
    return { ok: true, session, ...(kept.length > 0 ? { env } : {}) };
  };
}
