import { collectGitEffects, safeConfigPair } from './git-guards.ts';
import { foreignRepoReads, gitVerdict } from './git-verdict.ts';
import type { Word } from './shell-parse.ts';
import { wrapped } from './foreign.ts';
import { DANGER, type SegmentVerdict, type Walk } from './walk.ts';
import { writeKind } from './writes.ts';

/**
 * Окружение git, которое запускает программу со своего значения, — то же, что
 * ключ настроек под ним. Значение судится правилами `-c` из `git-guards.ts`
 * (`safeConfigPair`, один список опасных ключей на оба пути): раньше
 * `GIT_EDITOR=./x.sh git commit` и `GIT_SSH_COMMAND='rm -rf ~' git fetch` шли
 * рутиной, хотя `-c core.editor=./x.sh` — карточка (ревью 23.10, зона A).
 * `EDITOR`/`VISUAL` git берёт, когда `GIT_EDITOR` не задан; `SSH_ASKPASS` с
 * `SSH_ASKPASS_REQUIRE=force` OpenSSH исполняет и без терминала (A-06, A-07).
 */
const RUNS_AS_CONFIG: Readonly<Record<string, string>> = {
  GIT_EDITOR: 'core.editor',
  GIT_SEQUENCE_EDITOR: 'sequence.editor',
  GIT_PAGER: 'core.pager',
  GIT_ASKPASS: 'core.askpass',
  GIT_SSH_COMMAND: 'core.sshcommand',
  GIT_SSH: 'core.sshcommand',
  GIT_EXTERNAL_DIFF: 'diff.external',
  GIT_PROXY_COMMAND: 'core.gitproxy',
  EDITOR: 'core.editor',
  VISUAL: 'core.editor',
  // `PAGER` git берёт, когда нет `GIT_PAGER` и `core.pager` (аудит 23.10, A-09).
  PAGER: 'core.pager',
  SSH_ASKPASS: 'core.askpass',
  // Прокси на одну команду — как `-c http.proxy=…` (A-08): трафик к форжу уходит чужому узлу.
  HTTPS_PROXY: 'http.proxy',
  HTTP_PROXY: 'http.proxy',
  ALL_PROXY: 'http.proxy',
};

/**
 * Окружение, которым git подхватит программы или настройки из неизвестного
 * места: каталог подкоманд, шаблоны с хуками, настройки окружением
 * (`GIT_CONFIG_PARAMETERS="'core.editor=./x'"`). Безопасного значения нет.
 * `HOME` и `XDG_CONFIG_HOME` переносят глобальные настройки git в каталог,
 * куда агент мог записать `.gitconfig` с `core.fsmonitor` или `alias.x = !…`
 * (A-02: живой прогон — хук исполнился); судится как `GIT_CONFIG_GLOBAL`.
 */
const RUNS_ALWAYS =
  /^(GIT_(EXEC_PATH|TEMPLATE_DIR|CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL|SYSTEM)|CONFIG)|HOME|XDG_CONFIG_HOME)$/;

/** Трассировка git: число или `true` — поток, иное — путь файла, который git допишет. */
const TRACE = /^GIT_TRACE\w*$/;
const TRACE_TO_STREAM = /^(\d|true|false|yes|no|on|off)?$/i;

/**
 * Окружение, что уводит git в другой репозиторий, дерево, индекс или хранилище
 * объектов: путь значения судится как путь записи.
 */
const PATH_STEERING =
  /^GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/;

/** Имена, заданные этой командой и её префиксом, — в верхнем регистре (A-01) с исходным. */
function assigned(walk: Walk, env: ReadonlyMap<string, string | undefined>): Map<string, string> {
  const names = new Map<string, string>();
  for (const name of [...env.keys(), ...walk.assignedNames()]) names.set(name, name.toUpperCase());
  return names;
}

function valueOf(
  walk: Walk,
  env: ReadonlyMap<string, string | undefined>,
  name: string,
): string | undefined {
  if (env.has(name)) return env.get(name);
  return textOf(walk.expand({ text: `$${name}`, dynamic: true }));
}

/** Путь значения — в своей копии или во временном; неизвестное — нет. */
function staysHere(walk: Walk, value: string | undefined): boolean {
  if (value === undefined) return false;
  const kind = writeKind({ text: value, dynamic: false }, walk);
  return kind === 'inside' || kind === 'temp';
}

/**
 * Переменные, заданные этой командой, что исполнили бы у git чужую программу
 * или дописали бы файл вне копии (`GIT_TRACE=/c/Users/x/t.txt`, A-04, — как
 * `-c trace2.eventTarget=…`). Имя сверяется без регистра (A-01).
 */
export function gitEnvRuns(walk: Walk, env: ReadonlyMap<string, string | undefined>): boolean {
  for (const [name, upper] of assigned(walk, env)) {
    if (RUNS_ALWAYS.test(upper)) return true;
    if (TRACE.test(upper)) {
      const value = valueOf(walk, env, name);
      if (value === undefined || (!TRACE_TO_STREAM.test(value) && !staysHere(walk, value))) {
        return true;
      }
      continue;
    }
    const key = RUNS_AS_CONFIG[upper];
    if (!key) continue;
    const value = valueOf(walk, env, name);
    if (value === undefined || !safeConfigPair(`${key}=${value}`)) return true;
  }
  return false;
}

const textOf = (word: Word): string | undefined => (word.dynamic ? undefined : word.text);

/**
 * git, уведённый окружением в другой репозиторий, рабочее дерево или индекс
 * (`GIT_DIR`, `GIT_WORK_TREE`): затирание, снос и смена ветки там — не своей
 * копии, и снимок незакоммиченного перед ними не снять. Раньше такое звено
 * судилось лишь на пуш и слияние, и `GIT_WORK_TREE=../x git reset --hard` шло
 * само. Путь вне копии (или неизвестный) — запись туда человеку, чтение — как
 * раньше (ревью 23.10, A-03: `GIT_DIR=/c/other/.git git commit` шло само).
 */
export function steeredGitVerdict(
  words: Word[],
  walk: Walk,
  env: ReadonlyMap<string, string | undefined>,
): SegmentVerdict {
  const effects = collectGitEffects(() => gitVerdict(words, walk));
  if (effects.result.kind === 'danger' || effects.discards.length > 0 || effects.destroys) {
    return DANGER;
  }
  const away = [...assigned(walk, env)].some(
    ([name, upper]) => PATH_STEERING.test(upper) && !staysHere(walk, valueOf(walk, env, name)),
  );
  if (away && !foreignRepoReads(words)) return DANGER;
  return wrapped(words, true);
}
