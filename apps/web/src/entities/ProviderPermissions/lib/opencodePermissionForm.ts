import type { OpencodePermissionInfo } from '@agentdeck/contracts';
import type {
  OpencodeToolChoice,
  OpencodePatternRow,
  OpencodeFormState,
} from './opencodePermissionForm.types';

/** Разложить ответ сервера в состояние формы. */
export function toOpencodeFormState(data: OpencodePermissionInfo): OpencodeFormState {
  const choices: Record<string, OpencodeToolChoice> = {};
  for (const tool of data.tools) choices[tool] = 'unset';

  const patterns: Record<string, OpencodePatternRow[]> = {};
  let nextId = 0;
  for (const entry of data.entries) {
    if (entry.mode === 'patterns') {
      choices[entry.tool] = 'patterns';
      patterns[entry.tool] = (entry.patterns ?? []).map((rule) => ({
        id: nextId++,
        pattern: rule.pattern,
        level: rule.level,
      }));
    } else if (entry.level) {
      choices[entry.tool] = entry.level;
    }
  }
  return { choices, patterns };
}
