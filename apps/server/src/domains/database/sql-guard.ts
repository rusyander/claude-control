/**
 * Сторож запроса перед базой. Главная защита — НЕ он: запрос идёт внутри
 * `BEGIN READ ONLY`, и Postgres сам откажет любой записи. Сторож отсекает то,
 * что транзакция чтения пропускает, а человеку и агенту здесь не нужно:
 * функции с побочным действием (снять чужой сеанс, перечитать конфиг, сходить
 * в файловую систему сервера) и управляющие команды, которые читают «по виду».
 *
 * Разбор лексический: комментарии и строки вырезаются, остальное сравнивается
 * по словам. Полного парсера SQL тут нет и не нужно — сторож отказывает с
 * запасом, а пропущенное всё равно упирается в READ ONLY.
 */

/** Первое слово оператора, с которого запрос читает. */
const ALLOWED_FIRST = new Set(['select', 'with', 'explain', 'show', 'table', 'values']);

/**
 * Функции, которые работают и в транзакции чтения, но действуют наружу.
 * Сравнение по префиксу там, где у функции семейство (`pg_file_write`,
 * `pg_file_unlink`, `dblink_exec`…).
 */
const DENIED_FUNCTIONS = [
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_promote',
  'pg_switch_wal',
  'pg_create_restore_point',
  'pg_start_backup',
  'pg_stop_backup',
  'pg_backup_start',
  'pg_backup_stop',
  'pg_wal_replay_pause',
  'pg_wal_replay_resume',
  'pg_create_physical_replication_slot',
  'pg_create_logical_replication_slot',
  'pg_drop_replication_slot',
  'pg_replication_origin_',
  'pg_advisory_',
  'pg_try_advisory_',
  'pg_notify',
  'pg_sleep',
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_',
  'pg_stat_file',
  'pg_file_',
  'pg_logdir_ls',
  'set_config',
  'dblink',
  'lo_import',
  'lo_export',
  'lo_unlink',
  'lo_create',
  'lo_from_bytea',
  'lo_put',
  'lowrite',
  'nextval',
  'setval',
  'txid_current',
  'pg_current_xact_id',
];

/**
 * Слова, после которых запрос уже не чтение, где бы они ни стояли: изменение
 * данных внутри `WITH`, `SELECT … INTO`. READ ONLY откажет и сам — сторож
 * говорит об этом раньше и понятнее. Список короткий намеренно: каждое слово
 * здесь — колонка с таким именем, которую придётся брать в кавычки.
 */
const DENIED_WORDS = new Set([
  'insert',
  'update',
  'delete',
  'merge',
  'truncate',
  'drop',
  'create',
  'alter',
  'grant',
  'revoke',
  'copy',
  'into',
  'vacuum',
  'refresh',
  'call',
]);

export type SqlRefusal =
  | { reason: 'empty' }
  | { reason: 'unicode-escape' }
  | { reason: 'multiple' }
  | { reason: 'not-read'; word: string }
  | { reason: 'denied-word'; word: string }
  | { reason: 'denied-function'; name: string }
  | { reason: 'unterminated' };

export type SqlVerdict =
  { ok: true; sql: string; firstWord: string } | ({ ok: false } & SqlRefusal);

/**
 * Текст без комментариев и содержимого строк: строки заменены на `''`.
 * Идентификатор в кавычках остаётся словом — `"pg_sleep"(1)` вызывает ту же
 * функцию, что и без кавычек, и прятать его от проверки нельзя.
 */
export function stripSql(sql: string): { text: string; unterminated: boolean } {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? n : end;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      // Комментарии Postgres вкладываются: /* /* */ */.
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      if (depth > 0) return { text: out, unterminated: true };
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      // E'…' допускает экранирование обратной косой; обычная строка — только удвоение.
      const escapes = quote === "'" && /(^|[^\w$])e$/i.test(out);
      i += 1;
      let body = '';
      let closed = false;
      while (i < n) {
        const ch = sql[i] ?? '';
        if (escapes && ch === '\\') {
          i += 2;
          continue;
        }
        if (ch === quote) {
          if (sql[i + 1] === quote) {
            body += ch;
            i += 2;
            continue;
          }
          closed = true;
          i += 1;
          break;
        }
        body += ch;
        i += 1;
      }
      if (!closed) return { text: out, unterminated: true };
      out += quote === '"' ? `"${body.replace(/[^A-Za-z0-9_$]/g, '_')}"` : "''";
      continue;
    }
    if (c === '$') {
      // Долларовая строка: $$…$$ или $tag$…$tag$. `$1` — параметр, не строка.
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      // `a$b$` — имя с долларом внутри, а не начало строки.
      if (tag && !/[\w$]$/.test(out)) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end === -1) return { text: out, unterminated: true };
        i = end + tag[0].length;
        out += "''";
        continue;
      }
    }
    out += c ?? '';
    i += 1;
  }
  return { text: out, unterminated: false };
}

/**
 * Пропустить ли запрос. Возвращает текст без завершающей `;` — драйвер шлёт
 * его расширенным протоколом, а там второй оператор не пройдёт и сам.
 */
export function checkReadOnlySql(sql: string): SqlVerdict {
  const { text, unterminated } = stripSql(sql);
  if (unterminated) return { ok: false, reason: 'unterminated' };
  // U&"\0070g_sleep" — имя, собранное из кодов: по словам его не узнать. Ищем
  // по исходному тексту: такое сочетание внутри строки — редкость, а отказ
  // с запасом лучше пропуска.
  if (/\bu&\s*["']/i.test(sql)) return { ok: false, reason: 'unicode-escape' };
  const statements = text
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  const statement = statements[0];
  if (!statement) return { ok: false, reason: 'empty' };
  if (statements.length > 1) return { ok: false, reason: 'multiple' };

  const lower = statement.toLowerCase();
  // Имя в кавычках — колонка, а не оператор: `"update"` словом не считается.
  const words = lower.replace(/"[^"]*"/g, '""').match(/[a-z_][a-z0-9_$]*/g) ?? [];
  const firstWord = words[0] ?? '';
  if (!ALLOWED_FIRST.has(firstWord)) return { ok: false, reason: 'not-read', word: firstWord };

  const deniedWord = words.find((word) => DENIED_WORDS.has(word));
  if (deniedWord) return { ok: false, reason: 'denied-word', word: deniedWord };

  for (const call of lower.matchAll(/"?([a-z_][a-z0-9_$]*)"?\s*\(/g)) {
    const name = call[1] ?? '';
    if (isDeniedFunction(name)) return { ok: false, reason: 'denied-function', name };
  }
  return { ok: true, sql: sql.trim().replace(/;\s*$/, '').trimEnd(), firstWord };
}

/** Имя из списка или из его семейства: `dblink` → `dblink_exec`, `pg_ls_` → `pg_ls_dir`. */
function isDeniedFunction(name: string): boolean {
  return DENIED_FUNCTIONS.some((denied) =>
    denied.endsWith('_')
      ? name.startsWith(denied)
      : name === denied || name.startsWith(`${denied}_`),
  );
}
