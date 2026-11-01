import type { Gate, GateKind } from '@agentdeck/contracts/core/scenario';

/**
 * Поля формы шага ↔ значения схемы. Списки id человек пишет через запятую, варианты ответа —
 * по строке; пустые куски не уходят в сценарий (схема не примет пустой id).
 */

export function listOf(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Целое из поля: пусто — `undefined` (бюджета нет — без предела). Не число — `NaN`: схема
 * назовёт поле, а не промолчит о вписанном мусоре.
 */
export function intOf(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** Ворота нового вида: поля, которых вид требует, — пустыми (схема назовёт незаполненное). */
export function gateOf(kind: GateKind): Gate {
  if (kind === 'check-green') return { kind, checkId: '' };
  if (kind === 'text') return { kind, criterion: '' };
  return { kind };
}
