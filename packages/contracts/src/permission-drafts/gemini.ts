import type { GeminiPermissionDraft } from '../provider-permissions.ts';
import { GEMINI_APPROVAL_MODES, type GeminiApprovalMode } from '../vocabulary.ts';
import { parseToolList } from './normalize.ts';

/**
 * Режимы, которые Gemini понимает ТОЛЬКО как флаг командной строки: в
 * settings.json они вызывают ошибку enum при старте CLI. Панель их не пишет.
 */
export const GEMINI_CLI_ONLY_APPROVAL_MODES: readonly string[] = ['yolo'];

/**
 * Прислан режим, который Gemini принимает только как флаг CLI (`yolo`). Маршрут
 * отвечает 400 с отдельным объяснением: это не «битый ввод», а осознанный отказ
 * панели портить settings.json.
 */
export function isCliOnlyGeminiApprovalMode(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const mode = (body as Record<string, unknown>).approvalMode;
  return typeof mode === 'string' && GEMINI_CLI_ONLY_APPROVAL_MODES.includes(mode);
}

/** Разобрать черновик прав Gemini: режим из набора + белый и чёрный списки инструментов. */
export function parseGeminiDraft(rec: Record<string, unknown>): GeminiPermissionDraft | undefined {
  const approvalMode = rec.approvalMode;
  // `yolo` не проходит именно здесь — он не входит в GEMINI_APPROVAL_MODES.
  if (
    typeof approvalMode !== 'string' ||
    !(GEMINI_APPROVAL_MODES as readonly string[]).includes(approvalMode)
  )
    return undefined;

  const coreTools = parseToolList(rec.coreTools);
  const excludeTools = parseToolList(rec.excludeTools);
  if (!coreTools || !excludeTools) return undefined;

  return { approvalMode: approvalMode as GeminiApprovalMode, coreTools, excludeTools };
}
