/**
 * Типы для `outside-relay-hook-lib.mjs`.
 *
 * Сама библиотека — `.mjs`: хук запускается голым node, без сборки. Объявление
 * нужно только тесту, который зовёт её из TypeScript.
 */

export interface TranscriptToolUse {
  id: string;
  name?: string;
  input?: unknown;
}

export function scanTranscript(text: string): {
  uses: TranscriptToolUse[];
  results: Set<string>;
};

export function findToolUseId(text: string, toolName: string, input: unknown): string | undefined;

export function hasToolResult(text: string, toolUseId: string): boolean;

export interface PermissionHookOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: { behavior: 'allow' | 'deny'; updatedInput?: unknown; message?: string };
  };
}

export function permissionOutput(
  result: { state: string; answers?: { [question: string]: string }; behavior?: string },
  toolInput: object,
): PermissionHookOutput | undefined;

export interface MessagesHookOutput {
  hookSpecificOutput?: { hookEventName: 'PostToolUse'; additionalContext: string };
  decision?: 'block';
  reason?: string;
}

export function messagesOutput(
  event: string,
  texts: readonly string[],
): MessagesHookOutput | undefined;
