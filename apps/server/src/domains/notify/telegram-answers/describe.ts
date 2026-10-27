/**
 * Что агент хочет сделать — одной строкой словами, для жирной строки сообщения
 * Telegram. Команда целиком уходит ниже, в свёрнутую цитату; здесь — то, по чему
 * человек решает, не разворачивая её.
 *
 * Bash — своё `description` вызова (его пишет модель); правка файла — «Изменить
 * файл <имя>»; WebFetch — «Открыть <хост>»; MCP — «<сервер>: <инструмент>»;
 * остальное — имя инструмента.
 */

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

function basenameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

export function describeAsk(toolName: string | undefined, input: unknown): string | undefined {
  if (!toolName) return undefined;
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (toolName === 'Bash') return text(body.description) ?? toolName;
  if (FILE_TOOLS.has(toolName)) {
    const path = text(body.file_path) ?? text(body.notebook_path);
    return path ? `Изменить файл ${basenameOf(path)}` : toolName;
  }
  if (toolName === 'WebFetch') {
    const host = text(body.url) ? hostOf(text(body.url)!) : undefined;
    return host ? `Открыть ${host}` : toolName;
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return `${mcp[1]}: ${mcp[2]}`;
  return toolName;
}
