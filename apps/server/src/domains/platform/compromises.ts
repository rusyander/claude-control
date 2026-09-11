import type { CompromiseId, CompromiseView } from '@agentdeck/contracts';
// Значения (не типы) сервер берёт подпутём: бочка `index.ts` реэкспортирует без
// расширений и под `--experimental-strip-types` в рантайме не грузится вовсе.
import { COMPROMISES } from '@agentdeck/contracts/compromises';

/**
 * Подписи компромиссов в том виде, в каком их читает панель.
 *
 * Отдаёт сервер, а не фронт, хотя сам реестр лежит в общем пакете: как только
 * подпись снимут, элемент на экране обязан погаснуть сам, без правки разметки.
 * Списком владеет одна сторона — иначе снятая подпись живёт в интерфейсе до
 * следующего релиза фронта.
 */
export function compromiseViews(): CompromiseView[] {
  return COMPROMISES.map((entry) => ({
    id: entry.id,
    severity: entry.severity,
    since: entry.since,
    // Пустые якоря = обход подписан заранее, кода ещё нет. Человеку это видно
    // словом «ещё не в коде», а не молчанием: обещать проверенным то, что не
    // написано, — ровно тот случай, ради которого заведён инвариант 13.
    planned: entry.codeAnchors.length === 0,
    uiHidden: entry.uiHidden === true,
  }));
}

/**
 * Подписи, которые несёт конкретный объект ответа (`compromises: [...]`).
 * Идентификаторы сверяются с реестром: подпись, которой в реестре нет, — это
 * опечатка, и молча показывать её пустым значком нельзя.
 */
export function compromisesOf(ids: CompromiseId[]): CompromiseId[] {
  const known = new Set(COMPROMISES.map((entry) => entry.id));
  return ids.filter((id) => known.has(id));
}
