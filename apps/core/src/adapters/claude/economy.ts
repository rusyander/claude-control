import type { SessionSpec } from '../adapter.types.ts';
import { economyLevers, type EconomyCarry } from '../economy-carry.ts';

/**
 * Claude Code: окружение процесса (окно, IDE, напоминание) и ключи `--settings` ядра. Имена
 * переменных — Claude Code 2.1.310 (сверка 02.11, `economy-carry.ts`); живут в переходнике Claude,
 * не в общей части слоя (P108).
 */
export function claudeEconomy(spec: SessionSpec): EconomyCarry & {
  settings: { env?: Record<string, string>; bashOutputMaxChars?: number };
} {
  const e = spec.economy;
  const s = economyLevers(e);
  const env: Record<string, string> = {};
  if (s.compact) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(s.compact);
  if (s.ide) env.CLAUDE_CODE_AUTO_CONNECT_IDE = 'false';
  // Напоминание «давно не слышал человека» тратит ход на отчёт, которого в шаге никто не читает.
  if (e?.workHabits) env.CLAUDE_CODE_SILENT_TURN_REMINDER = '0';
  const settingsEnv: Record<string, string> = {
    ...(s.read ? { CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS: String(s.read) } : {}),
    ...(s.ttl ? { CLAUDE_CODE_PROMPT_CACHE_TTL: s.ttl } : {}),
  };
  return {
    env,
    lost: [],
    settings: {
      ...(Object.keys(settingsEnv).length > 0 ? { env: settingsEnv } : {}),
      // Ключ настроек, не `BASH_MAX_OUTPUT_LENGTH`: переменная задаёт лишь окно дочитывания.
      ...(s.bash ? { bashOutputMaxChars: s.bash } : {}),
    },
  };
}
