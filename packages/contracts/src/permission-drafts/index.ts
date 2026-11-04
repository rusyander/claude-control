/**
 * Разбор черновиков прав семи CLI (Codex, Gemini, Cursor, Continue, Goose, Kimi,
 * OpenCode) — точка экспорта `@agentdeck/contracts/permissions`.
 *
 * Одна копия на сервер и ядро: две копии разбора расходятся молча, у каждой свой
 * зелёный тест. Модули грузятся из исходников под strip-types, поэтому импорт
 * значения — только с расширением `.ts` и только из самодостаточного
 * `../vocabulary.ts`; из `../provider-permissions.ts` (тянет zod и бочку без
 * расширений) — лишь типы, они стираются.
 */
export { parseToolList } from './normalize.ts';
export { parseCodexDraft } from './codex.ts';
export {
  GEMINI_CLI_ONLY_APPROVAL_MODES,
  isCliOnlyGeminiApprovalMode,
  parseGeminiDraft,
} from './gemini.ts';
export { parseCursorDraft } from './cursor.ts';
export { parseContinueDraft } from './continue.ts';
export { parseGooseDraft } from './goose.ts';
export { parseKimiDraft } from './kimi.ts';
export {
  OPENCODE_PATTERN_TOOLS,
  isOpencodeLevel,
  parseOpencodeDraft,
  supportsPatternMap,
} from './opencode.ts';

export {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  CURSOR_RULE_KINDS,
  GEMINI_APPROVAL_MODES,
  GOOSE_MODES,
  KIMI_ACP_MODES,
  KIMI_DECISIONS,
  KIMI_MODES,
  OPENCODE_PERMISSION_LEVELS,
  OPENCODE_PERMISSION_TOOLS,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
  type CursorPermissionKind,
  type GeminiApprovalMode,
  type GooseMode,
  type KimiAcpMode,
  type KimiDecision,
  type KimiMode,
  type OpencodePermissionLevel,
  type OpencodePermissionTool,
} from '../vocabulary.ts';
