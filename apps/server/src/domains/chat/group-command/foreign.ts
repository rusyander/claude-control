import { killsProcess } from './kill.ts';
import { dbDanger } from './risky.ts';
import type { Word } from './shell-parse.ts';
import { DANGER, OTHER, type SegmentVerdict } from './walk.ts';

/**
 * Звенья, которые судятся по словам целиком: форж и HTTP, обёртки, которые
 * снять не вышло. Вынесено из `group-command.ts` по размеру.
 */

export const FORGE_CLI = new Set(['gh', 'glab']);
export const HTTP_CLI = new Set([
  'curl',
  'wget',
  'http',
  'https',
  'xh',
  'iwr',
  'irm',
  'invoke-webrequest',
  'invoke-restmethod',
]);

/**
 * Форж и HTTP: слияние MR (`gh pr merge`, `glab mr merge`, `…/merge` в адресе)
 * и удаление (`… delete`, метод DELETE) — человеку. Прочее — правила чата.
 */
export function forgeVerdict(words: Word[]): SegmentVerdict {
  const name = (words[0] as Word).text.toLowerCase();
  const texts = words.map((word) => word.text);
  const method = texts.some(
    (text, i) =>
      /^(-X|--request|--method|-Method)$/i.test(texts[i - 1] ?? '') && /^delete$/i.test(text),
  );
  const toMerge = texts.some((text) => /\/merge(\b|$)/.test(text));
  if (method || toMerge) return DANGER;
  if (FORGE_CLI.has(name) && texts.slice(1, 3).some((text) => /^(merge|delete)$/.test(text))) {
    return DANGER;
  }
  return OTHER;
}

/** Обёртки, внутри которых исполняется другая команда, если снять их не вышло. */
export const WRAPPERS = new Set([
  'sudo',
  'env',
  'xargs',
  'bash',
  'sh',
  'zsh',
  'pwsh',
  'powershell',
  'cmd',
  'nohup',
  'timeout',
  'nice',
  'wsl',
  'ssh',
  'find',
  'eval',
  'exec',
  'command',
  'builtin',
  'trap',
  'setsid',
  'coproc',
  'busybox',
  'toybox',
  'doas',
  'flock',
  'taskset',
  'ionice',
  'unbuffer',
  'stdbuf',
]);

/**
 * `git … push|merge|branch -D` внутри чужой обёртки: `bash -c "git push origin main"`.
 * `merge-tree` и `merge-base` — сверка, а не слияние: имя подкоманды целиком.
 */
const WRAPPED_GIT =
  /\bgit\b[^\n]*(?<![\w-])(push|merge)(?![\w-])|\bgit\b[^\n]*\bbranch\b[^\n]*\s-[a-zA-Z]*[dD]\b/;
const WRAPPED_REMOVE =
  /(^|[\s;&|"'\\])(rm|rmdir|rd|del|erase|unlink|shred|rimraf|trash|Remove-Item)\s|\s-delete\b/i;

/** Клиенты баз с адресом сервера ключом `-h`/`--host` или адресом-ссылкой. */
const SQL_CLIENT = /^(psql|mysql|mariadb|pgcli|mycli|clickhouse-client)(\.exe)?$/i;
const LOCAL_HOST =
  /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|0\.0\.0\.0|host\.docker\.internal|\/.*)?$/i;
const DB_URI = /^(postgres(ql)?|mysql|mariadb|clickhouse):\/\/(?:[^@/]*@)?(\[[^\]]*\]|[^:/?]*)/i;

/**
 * Запрос к базе на другом сервере, чей текст не виден в словах: файл (`-f`),
 * вход по трубе или из файла, тело heredoc (R-C05, ревью корпуса 23.10: `psql
 * -h db.prod … -f x.sql` проходил сам). Видимый запрос (`-c "select 1"`)
 * судят строки чата по тексту; свой сервер — обычная работа.
 */
function remoteOpaqueSql(words: Word[]): boolean {
  const name = (words[0]?.text.split(/[\\/]/).at(-1) ?? '').toLowerCase();
  if (!SQL_CLIENT.test(name)) return false;
  const texts = words.slice(1).map((word) => word.text);
  const hosts: string[] = [];
  let inline = false;
  let file = false;
  for (let i = 0; i < texts.length; i += 1) {
    const text = texts[i] as string;
    if (/^(-h|--host)$/.test(text)) hosts.push(texts[(i += 1)] ?? '');
    else if (/^--host=/.test(text)) hosts.push(text.slice(7));
    else if (/^-h./.test(text)) hosts.push(text.slice(2));
    else if (/^(-c|--command|-e|--execute)(=|$)/.test(text)) inline = true;
    else if (/^(-f|--file)(=|$)/.test(text)) file = true;
    const uri = DB_URI.exec(text);
    if (uri) hosts.push(uri[3] ?? '');
  }
  const remote = hosts.some((host) => !LOCAL_HOST.test(host.replace(/^\[|\]$/g, '')));
  return remote && (file || !inline);
}

export function wrapped(words: Word[], wrapper: boolean): SegmentVerdict {
  const text = words.map((word) => word.text).join(' ');
  if (WRAPPED_GIT.test(text) || dbDanger(words)) return DANGER;
  if (remoteOpaqueSql(words)) return { kind: 'other', rules: ['database'] };
  if (wrapper && WRAPPED_REMOVE.test(text)) return DANGER;
  // `powershell -Command "Stop-Process -Id 1"`, `ssh host kill 1`: погашение в
  // обёртке, которую не снять, — чьё гасится, не проследить (N3).
  if (wrapper && words.slice(1).some((word) => killsProcess(word.text))) return DANGER;
  return OTHER;
}
