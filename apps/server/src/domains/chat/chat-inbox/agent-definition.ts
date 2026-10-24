import { join } from 'node:path';
import { readSubagentFile } from '../../portability/subagents.ts';
import type { AgentDefinition } from './ask-source.ts';

/**
 * Модель и усилие агента по его типу — из описания `agents/<тип>.md`: сначала
 * проекта (`.claude/agents`), затем общего каталога конфигурации. Так же ищет
 * агента сам CLI: проектный перекрывает общий.
 *
 * Нужен подписи запуска: вызов `Agent` модель называет не всегда, а «на чём
 * пойдёт агент» — половина решения «пускать ли».
 */
export function readAgentDefinition(
  configRoot: string,
  subagentType: string,
  projectPath: string,
): AgentDefinition | undefined {
  // Тип — имя файла: ни разделителей пути, ни точек в начале.
  if (!/^[\w][\w.-]{0,80}$/.test(subagentType)) return undefined;
  const places = [
    ...(projectPath ? [join(projectPath, '.claude', 'agents', `${subagentType}.md`)] : []),
    join(configRoot, 'agents', `${subagentType}.md`),
  ];
  for (const file of places) {
    const parsed = readSubagentFile(file);
    if ('detail' in parsed) continue;
    const effort = /^effort:\s*["']?([\w-]+)/m.exec(frontmatterOf(parsed.raw))?.[1];
    return {
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(effort ? { effort } : {}),
    };
  }
  return undefined;
}

function frontmatterOf(raw: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  return match?.[1] ?? '';
}
