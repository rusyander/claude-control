import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  GeminiApprovalMode,
  QwenApprovalMode,
} from '@agentdeck/contracts';

/**
 * Дефолты и наборы, нужные только чтению и записи сервера. Наборы Codex, Gemini и
 * Cursor и разбор черновиков лежат одной копией в `@agentdeck/contracts/permissions`.
 */

/** Дефолты Codex (когда ключ отсутствует). НЕ записываются молча — только по действию пользователя. */
export const DEFAULT_APPROVAL: CodexApprovalPolicy = 'on-request';
export const DEFAULT_SANDBOX: CodexSandboxMode = 'workspace-write';

/** Дефолт Gemini: спрашивать подтверждение перед каждым вызовом инструмента. */
export const DEFAULT_GEMINI_APPROVAL: GeminiApprovalMode = 'default';

/**
 * Режимы аппрувов Qwen Code, допустимые в `settings.json` (`tools.approvalMode`).
 * `yolo` входит СОЗНАТЕЛЬНО: у Qwen он задокументирован как значение файла (в
 * отличие от Gemini, где это только флаг командной строки).
 */
export const QWEN_APPROVAL_MODES: readonly QwenApprovalMode[] = [
  'default',
  'plan',
  'auto-edit',
  'auto',
  'yolo',
];

/** Дефолт Qwen: спрашивать подтверждение перед каждым действием. */
export const DEFAULT_QWEN_APPROVAL: QwenApprovalMode = 'default';
