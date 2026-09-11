import type { PlatformStatus } from '@agentdeck/contracts';

/**
 * Как назвать состояние контура одной строкой. Отдельно от запроса, потому что
 * это правило, а не транспорт: тесты телефона гоняют логику, а не нативное.
 */

/** Что видно человеку. `ok` — контур отвечал, и это проверено пробой. */
export type PlatformProblem = 'exhausted' | 'off' | 'noKey' | 'failed' | 'unchecked' | 'ok';

/**
 * Порядок ответов — от худшего к лучшему: сначала то, из-за чего работа встала.
 *
 * Отказ по бюджету идёт ПЕРВЫМ и обгоняет даже «выключен»: 402 значит, что
 * контур уже отказал живому запросу, и это единственное состояние, которое
 * человек не создавал сам и о котором иначе не узнает.
 *
 * Контур без пробы — НЕ «работает». Панель ни разу к нему не ходила (ни одной
 * пробы по кнопке, свежая настройка, разворот архива), и зелёная строка на
 * телефоне обещала бы живой контур на основании пустого места. Телефон не
 * пробует сам: он только на чтение.
 */
export function platformProblem(status: PlatformStatus): PlatformProblem {
  if (status.budget.exhausted) return 'exhausted';
  if (!status.platform.enabled) return 'off';
  if (!status.hasToken) return 'noKey';
  if (!status.health) return 'unchecked';
  if (status.health.outcome !== 'ok') return 'failed';
  return 'ok';
}

/**
 * Каким цветом сказать вердикт. Три состояния, а не два: «ещё не проверялся» —
 * не беда и не успех, и тревожный цвет прочитался бы как поломка контура,
 * которой никто не видел.
 */
export function platformTone(problem: PlatformProblem): 'ok' | 'bad' | 'quiet' {
  if (problem === 'ok') return 'ok';
  if (problem === 'unchecked') return 'quiet';
  return 'bad';
}

/**
 * Доля бюджета в процентах, целыми. Панель уже удерживает долю в пределах
 * единицы, но телефон читает чужой ответ и не обязан ему верить: 150 % на
 * экране выглядели бы ошибкой счёта, а не превышением.
 */
export function budgetPercent(status: PlatformStatus): number {
  return Math.min(100, Math.max(0, Math.round(status.budget.share * 100)));
}
