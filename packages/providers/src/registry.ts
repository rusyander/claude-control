import { aiderRunFacts } from './aider.ts';
import { claudeRunFacts } from './claude.ts';
import { codexRunFacts } from './codex.ts';
import { continueRunFacts } from './continue.ts';
import { cursorRunFacts } from './cursor.ts';
import { geminiRunFacts } from './gemini.ts';
import { gooseRunFacts } from './goose.ts';
import { kimiRunFacts } from './kimi.ts';
import { opencodeRunFacts } from './opencode.ts';
import { qwenRunFacts } from './qwen.ts';
import type { CliRunFacts } from './types.ts';

/**
 * Все CLI с фактами запуска, в порядке каталога панели (он же порядок карточек). Новый CLI —
 * один модуль рядом и одна строка здесь; каталог панели сверяет себя с этим списком тестом.
 */
export const CLI_RUN_FACTS: readonly CliRunFacts[] = [
  claudeRunFacts,
  codexRunFacts,
  geminiRunFacts,
  qwenRunFacts,
  continueRunFacts,
  gooseRunFacts,
  kimiRunFacts,
  cursorRunFacts,
  opencodeRunFacts,
  aiderRunFacts,
];

/** Факты CLI по id; чужой id — `undefined` (id сверяется в рантайме, не типом — P108). */
export function cliRunFacts(id: string): CliRunFacts | undefined {
  return CLI_RUN_FACTS.find((facts) => facts.id === id);
}
