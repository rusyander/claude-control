import type { Word } from './shell-parse.ts';

/**
 * Грубые проверки текста, который не разобрать как команду: тело heredoc у
 * `psql` или `ssh`, неразобранная команда, код интерпретатора. Пуш, слияние,
 * удаление веток, снос базы в нём есть — человеку.
 */

/** Клиенты баз: снос в их команде — человеку. */
export const DB_CLIENT =
  /^(psql|mysql|mariadb|sqlite3|sqlcmd|mongosh|mongo|redis-cli|clickhouse-client|clickhouse|pgcli|mycli|duckdb|cqlsh)(\.exe)?$/i;
const DB_DROP =
  /\b(drop\s+(table|database|schema|index|view|materialized|sequence|user|role|owned|extension|type|function|collection)|truncate\b|delete\s+from\b|flushall\b|flushdb\b|dropDatabase\b)|\.drop\s*\(/i;
/** Снос базы самостоятельной командой: `dropdb`, `prisma migrate reset`, `db:drop`. */
const DB_DESTROY =
  /(^|\s)(dropdb|dropuser)(\s|$)|\bprisma\s+migrate\s+reset\b|\bprisma\s+db\s+push\b.*--force-reset\b|\bdb:(drop|reset)\b|\bmanage\.py\s+flush\b|\bmigrate(:|\s+)(reset|fresh|rollback|down)\b/i;

export function isDbClient(words: Word[]): boolean {
  return words.some((word) => DB_CLIENT.test(word.text.split(/[\\/]/).at(-1) ?? ''));
}

export function dbDanger(words: Word[]): boolean {
  const text = words.map((word) => word.text).join(' ');
  if (DB_DESTROY.test(text)) return true;
  return isDbClient(words) && DB_DROP.test(text);
}

const RISKY_TEXT = [
  /(^|[;&|\n(`]\s*)git\b(\s+-\S+(\s+\S+)?)*\s+(push|merge)(?![\w-])/,
  /\bgit\b[^\n]*\b(branch|tag)\b[^\n]*\s(-[a-zA-Z]*[dD]|--delete)\b/,
  /(^|[;&|\n(`]\s*)(rm|Remove-Item|rd|rmdir|del|unlink)\s/i,
  DB_DROP,
  DB_DESTROY,
  /\/merge\b|-X\s*['"]?DELETE/i,
];

export const risky = (text: string): boolean => RISKY_TEXT.some((pattern) => pattern.test(text));

/**
 * Код интерпретатора (`python -c`, `node -e`, тело `python - <<'EOF'`): в нём
 * `del x` — оператор Python, `df.drop(columns=…)` — таблица pandas, а не снос.
 * Человеку — git-пуш и слияние, снос базы, HTTP DELETE и слияние по API.
 */
const RISKY_CODE = [
  /\bgit\b(\s+-\S+(\s+\S+)?)*\s+(push|merge)(?![\w-])/,
  /['"`]git['"`]\s*,\s*(['"`]-\S+['"`]\s*,\s*)*['"`](push|merge)['"`]/,
  /\bgit\b[^\n]*\b(branch|tag)\b[^\n]*\s(-[a-zA-Z]*[dD]|--delete)\b/,
  /\b(drop\s+(table|database|schema|collection)|truncate\s+table|delete\s+from|flushall|flushdb)\b|\bdropDatabase\s*\(|\.drop\(\s*\)/i,
  DB_DESTROY,
  /\/merge\b|method\s*[:=]\s*['"]DELETE['"]|-X\s*['"]?DELETE/i,
];

export const riskyCode = (code: string): boolean =>
  RISKY_CODE.some((pattern) => pattern.test(code));

/** Правило чата, под которое подпадает код: запись в базу, удаление файлов. */
export type CodeRule = 'database' | 'filesDelete';

const SQL_WRITE =
  /\b(insert\s+into|update\s+[\w."`[\]]+\s+set|alter\s+table|create\s+(table|index|schema|database|view))\b/i;
const CODE_DELETE =
  /\b(rmtree|rmSync|rmdirSync|unlinkSync|rimraf)\b|\bos\.(remove|unlink|rmdir|removedirs)\s*\(|\.unlink\s*\(|\bfs(\/promises)?\.(rm|unlink|rmdir)\b|\bFileUtils\.rm/;

export function codeRules(code: string): CodeRule[] {
  const rules: CodeRule[] = [];
  if (SQL_WRITE.test(code)) rules.push('database');
  if (CODE_DELETE.test(code)) rules.push('filesDelete');
  return rules;
}
