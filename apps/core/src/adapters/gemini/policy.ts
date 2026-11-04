import type { DenySet } from '../adapter.types.ts';
import { GEMINI_PATH_ARGS, GEMINI_TOOL_NAMES } from './permission.ts';

/**
 * Оверлей запретов ядра для Gemini CLI 0.66 — файл политики уровня пользователя
 * (`$GEMINI_CLI_HOME/.gemini/policies/*.toml`), у каждого сеанса свой дом. Хук `BeforeTool` под
 * `--acp` не вызывается (бандл 0.66: ACP `runTool` зовёт `invocation.execute` напрямую), поэтому
 * защита ядра у Gemini — эта политика, а вторым замком — вопрос о праве в режиме `default`.
 *
 * Живые пробы 02.11 (stub-model, подставной git): правило `deny` с `toolName =
 * "run_shell_command"` и `commandPrefix = "git push"` держит и прямой, и сцепленный (`cd . && …`)
 * push во всех четырёх режимах; `env git push` префикс обходит — поэтому к каждому префиксу идёт
 * правило по словам (`commandRegex`). Регулярное выражение — без групп с повтором: Gemini
 * отбрасывает правило, где после `(` где-то дальше стоит `)` с повтором (`isSafeRegExp`, «ReDoS»),
 * и делает это молча для сеанса — проверка правила по словам здесь именно поэтому.
 */

export const GEMINI_POLICY_FILE = 'agentdeck-core.toml';
const PRIORITY = 999;

const toml = (value: string): string => JSON.stringify(value);
const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** Значение так, как оно стоит внутри строки JSON аргументов (Gemini сверяет по `stableStringify`). */
const inJson = (value: string): string => regexEscape(JSON.stringify(value).slice(1, -1));
/** Слово команды целиком: соседний знак не буква, не цифра, не `_`, `.` или `-`. */
const word = (token: string): string => `(?<![\\w.-])${regexEscape(token)}(?![\\w.-])`;

/**
 * Слова argv по порядку внутри строки команды: `[^"]*` между ними не выходит за кавычку строки
 * JSON. Лишний запрет (`echo git push`) допустим — пропуск нет.
 */
export function commandWordsRegex(argv: readonly string[]): string {
  return `[^"]*${argv.map(word).join('[^"]*')}`;
}

function rule(fields: Record<string, string>, message: string): string {
  const lines = ['[[rule]]'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k} = ${toml(v)}`);
  lines.push('decision = "deny"', `priority = ${PRIORITY}`, `denyMessage = ${toml(message)}`);
  return lines.join('\n');
}

export function geminiPolicyToml(deny: DenySet): string {
  const rules: string[] = [];
  for (const argv of deny.commands) {
    if (argv.length === 0) continue;
    const message = `agentdeck core: \`${argv.join(' ')}\` is closed in this session`;
    rules.push(rule({ toolName: 'run_shell_command', commandPrefix: argv.join(' ') }, message));
    rules.push(
      rule({ toolName: 'run_shell_command', commandRegex: commandWordsRegex(argv) }, message),
    );
  }
  const tools = new Set(deny.tools.flatMap((cls) => GEMINI_TOOL_NAMES[cls]));
  for (const tool of [...tools].sort()) {
    rules.push(rule({ toolName: tool }, `agentdeck core: ${tool} is closed in this session`));
  }
  for (const path of deny.paths) {
    const message = `agentdeck core: ${path} is closed in this session`;
    for (const [tool, arg] of Object.entries(GEMINI_PATH_ARGS)) {
      rules.push(rule({ toolName: tool, argsPattern: `"${arg}":"${inJson(path)}` }, message));
    }
    rules.push(
      rule({ toolName: 'run_shell_command', commandRegex: `[^"]*${inJson(path)}` }, message),
    );
  }
  for (const path of deny.editPaths ?? []) {
    const message = `agentdeck core: ${path} is read-only in this session`;
    for (const tool of GEMINI_TOOL_NAMES.edit) {
      rules.push(rule({ toolName: tool, argsPattern: `"file_path":"${inJson(path)}` }, message));
    }
  }
  return `${rules.join('\n\n')}\n`;
}
