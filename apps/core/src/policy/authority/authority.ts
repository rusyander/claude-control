import type { AuthorityKind } from '@agentdeck/contracts/core/commands';
import type { JournalDataV1 } from '@agentdeck/contracts/core/journal';

/**
 * Кто вправе подать команду (06 §Authority, F23, P97). Решение — чистая функция по
 * доказательствам, собранным каналом: класс токена, одноразовое число страницы, пир-процесс и
 * подпись устройства. Ни один токен человека не доказывает (сессия может прочитать любой файл).
 *
 * - `human` — запуск, пауза, правка сценария…: число страницы + пир не из дерева сессии, или
 *   подпись устройства. Пир `unknown` с годным числом принимается — так в таблице 06.
 * - `human-strict` — ответ, одобрение, грант, публикация…: число + пир `clear`; пир `unknown` —
 *   только подпись устройства.
 * - Удалённая дорога (пир — демон Tailscale) и пересылка от непроверенного звена — только подпись.
 * - Токен сессии или пир из дерева сессии — отказ и сигнал `forged-authority`, даже с подписью.
 */

export type CommandProof = JournalDataV1['command.received']['proof'];

export type ProofClass = 'human' | 'human-strict';

/**
 * Класс доказательства на КАЖДЫЙ вид — таблица исчерпывающая: новый вид команды не соберётся, пока
 * не назван его класс. Оценка (`/v1/estimate`) создаёт задачу — `human`, как запуск; правка списка
 * требований — единственная дорога к `waived`, поэтому `human-strict`, как ответ и грант (G2).
 */
export const COMMAND_PROOF_CLASS: Record<AuthorityKind, ProofClass> = {
  estimate: 'human',
  // Лёгкая сессия панели (этап 10, F2): создаёт задачу и запускает CLI — класс оценки и запуска.
  ask: 'human',
  launch: 'human',
  pause: 'human',
  resume: 'human',
  cancel: 'human',
  'set-model': 'human',
  'set-cli': 'human',
  'set-route': 'human',
  'edit-scenario': 'human',
  'edit-split': 'human',
  'message-to-step': 'human',
  // Конец чата — тот же класс, что ход в нём: человек закрывает свой разговор (этап 10).
  'end-chat': 'human',
  answer: 'human-strict',
  'edit-requirements': 'human-strict',
  'approve-split': 'human-strict',
  grant: 'human-strict',
  'fresh-rerun': 'human-strict',
  'publish-now': 'human-strict',
  'release-resource': 'human-strict',
  'clear-exhausted': 'human-strict',
  'move-build': 'human-strict',
  'clean-remote': 'human-strict',
  // Настройка ядра (пункт 5, `grantRequired`, доверие репозиториям) — шире любой задачи (F23).
  'set-config': 'human-strict',
  // Библиотека сценариев общая для всех задач, запись однократная — шире любой задачи (F6).
  'save-scenario': 'human-strict',
  // Ключ устройства доказывает человека для каждой строгой команды — перенос ключей строже всех (F11).
  'adopt-devices': 'human-strict',
  // Сброс ключа обучения (этап 11, P140): таблица обучения общая для всех задач машины — строже
  // задачи, как настройка; модель и сессия до неё не дотягиваются.
  'learned-reset': 'human-strict',
  // Этап 12 (08e): перехват — правка копии рукой человека мимо шагов ядра, строго, как грант.
  'take-over': 'human-strict',
  // Возврат, остановка, доработка и ход на доске — ходы человека в своей задаче, как пауза и запуск.
  'hand-back': 'human',
  'set-stop': 'human',
  rework: 'human',
  'board-move': 'human',
  // Записи во «Входящие» (P167): только записи, задачу из них запускает доска — как ход на доске.
  'inbox-create': 'human',
};

export type AuthorityDecision =
  | { allow: true; by: 'nonce+peer' | 'device-signature' }
  | { allow: false; code: AuthorityRefusal; reason: string; signal: 'forged-authority' | null };

export type AuthorityRefusal =
  | 'forged-authority'
  | 'proof-required'
  | 'nonce-invalid'
  | 'signature-invalid'
  | 'signature-required';

/**
 * Виды, которые шлёт бот Telegram (этап 12, D29, P187) — список, а не класс: ни один путь Telegram
 * не выдаёт `grant`, `set-route`, `set-config`, `take-over`, `publish-now`… Аккаунт владельца
 * достижим с этой же машины (файлы Telegram Desktop, MCP пользовательского аккаунта), поэтому
 * Telegram слабее ключа телефона: только ходы внутри копии и маршрута задачи, которые кончаются MR
 * со слиянием руками. Поле строгих (`answer`, `approve-split`) сужает суд области
 * (`conductor/commands/telegram-scope.ts`).
 */
const TELEGRAM_KINDS: ReadonlySet<AuthorityKind> = new Set<AuthorityKind>([
  'cancel',
  'rework',
  'set-model',
  'set-cli',
  'board-move',
  'inbox-create',
  'answer',
  'approve-split',
]);

/** Пир `telegram` вправе подать вид: он в списке и пришёл токеном ядра (звено панели). */
function telegramMay(kind: AuthorityKind, proof: CommandProof): boolean {
  return proof.token === 'core' && TELEGRAM_KINDS.has(kind);
}

export function decideAuthority(kind: AuthorityKind, proof: CommandProof): AuthorityDecision {
  if (proof.token === 'session' || proof.peer === 'session-descendant') {
    return {
      allow: false,
      code: 'forged-authority',
      reason: 'command from a session token or a session-descendant process',
      signal: 'forged-authority',
    };
  }
  if (proof.token === 'none') {
    return { allow: false, code: 'proof-required', reason: 'no channel token', signal: null };
  }
  if (proof.signature === 'valid') return { allow: true, by: 'device-signature' };
  if (proof.signature === 'invalid') {
    return {
      allow: false,
      code: 'signature-invalid',
      reason: 'device signature not accepted',
      signal: null,
    };
  }
  if (proof.peer === 'telegram' && !telegramMay(kind, proof)) {
    return {
      allow: false,
      code: 'signature-required',
      reason: `peer telegram: ${kind} is not a Telegram command — only the panel or a device signature`,
      signal: null,
    };
  }
  const signatureOnly =
    proof.peer === 'remote' ||
    proof.peer === 'untrusted-forward' ||
    (proof.peer === 'unknown' && COMMAND_PROOF_CLASS[kind] === 'human-strict');
  if (signatureOnly) {
    return {
      allow: false,
      code: 'signature-required',
      reason: `peer ${proof.peer}: only a device signature proves a human for ${kind}`,
      signal: null,
    };
  }
  if (proof.nonce === 'valid') return { allow: true, by: 'nonce+peer' };
  if (proof.nonce === 'invalid') {
    return {
      allow: false,
      code: 'nonce-invalid',
      reason: 'nonce replayed, expired or from another page load',
      signal: null,
    };
  }
  return { allow: false, code: 'proof-required', reason: 'no human proof', signal: null };
}
