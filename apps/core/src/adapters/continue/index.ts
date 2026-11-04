import { continueRunFacts } from '@agentdeck/providers/continue';
import type { CliAdapter } from '../adapter.types.ts';
import { createGatelessAdapter } from '../gateless.ts';

/**
 * Continue CLI (`cn`) 1.5.47: настройки хуков читаются (`settings.json`, формат Claude), но путь
 * исполнения инструмента зовёт только учёт git-ai — `PreToolUse` не вызывается (dist/index.js,
 * 02.11). Оверлей `--exclude Bash(git push*)` — шаблон по началу строки: `cd . && git push` его
 * обходит. Ни то, ни другое не судья — запуск отказан (Q8), пока хук не доказан живьём.
 */
export function createContinueAdapter(): CliAdapter {
  return createGatelessAdapter(
    continueRunFacts,
    'reads hook settings but never fires PreToolUse (cn 1.5.47), and its --exclude patterns match a command prefix only',
  );
}
