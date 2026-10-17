/**
 * Измеритель расхода лимитов (этап 0 плана экономии, 17.10.2026): по сессиям
 * агента — куда ушло окно. Вход — транскрипт Claude Code или журнал
 * Codex/Qwen; выход — слагаемые формулы «вызовы × (постоянная часть +
 * накопленное) + запись + вывод» и то, что их раздувает. Командная строка —
 * `tools/token-audit.mjs` (`pnpm tokens`).
 */
export { auditClaudeRows, parseTranscript } from './claude-audit.ts';
export { auditForeignLines } from './foreign-audit.ts';
export {
  auditClaudeFile,
  auditForeignFile,
  findClaudeTranscript,
  foreignChatLogs,
  splitChats,
  splitSessionIds,
  type ForeignChatLogs,
  type ForeignChatRef,
} from './audit-files.ts';
export {
  checkLimits,
  compareHeadlines,
  formatSession,
  formatTotal,
  headline,
  totalHeadline,
  type Headline,
} from './report.ts';
export { foreignHomes } from '../scanner/foreign.ts';
export { stepClass } from './step-class.ts';
export type * from './token-audit.types.ts';
