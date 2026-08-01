import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  CursorPermissionKind,
  GeminiApprovalMode,
  QwenApprovalMode,
} from '@claude-control/contracts';

/** Разрешённые значения (дублируют contracts значением — в рантайм сервера contracts тянется лишь как тип). */
export const APPROVAL_POLICIES: readonly CodexApprovalPolicy[] = [
  'untrusted',
  'on-request',
  'never',
];
export const SANDBOX_MODES: readonly CodexSandboxMode[] = [
  'read-only',
  'workspace-write',
  'danger-full-access',
];

/** Разрешённые в settings.json режимы аппрувов Gemini. `yolo` сюда НЕ входит. */
export const GEMINI_APPROVAL_MODES: readonly GeminiApprovalMode[] = [
  'default',
  'auto_edit',
  'plan',
];

/**
 * Режимы, которые Gemini понимает ТОЛЬКО как флаг командной строки: в
 * settings.json они вызывают ошибку enum при старте CLI. Панель их не пишет.
 */
export const GEMINI_CLI_ONLY_APPROVAL_MODES: readonly string[] = ['yolo'];

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

/**
 * Задокументированные формы правил Cursor. Список идёт КЛИЕНТУ как подсказка и
 * НЕ используется как фильтр: панель правила не толкует (см. `parseCursorDraft`).
 */
export const CURSOR_RULE_KINDS: readonly CursorPermissionKind[] = [
  'Shell',
  'Read',
  'Write',
  'WebFetch',
  'Mcp',
];
