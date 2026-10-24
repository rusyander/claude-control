import { DETACHED } from './branch.ts';
import type { Word } from './shell-parse.ts';
import {
  DANGER,
  OTHER,
  ROUTINE,
  isProtectedBranch,
  type SegmentVerdict,
  type Walk,
} from './walk.ts';

/**
 * Охрана git, которая не про «куда пуш»: ключи и подкоманды, что запускают
 * программу, ссылки, общие для всех копий, удаление средствами git и то, что
 * сотрёт незакоммиченную работу (решения владельца 23.10).
 *
 * Копия группы — рабочее дерево ОСНОВНОГО репозитория: ветки, метки, тайник,
 * журнал ссылок и хранилище объектов у неё общие с основной копией и с
 * соседними группами. «Своя копия — группы» решает файлы копии, а не их.
 */

/**
 * Ключи настроек, что запускают программу, уводят git в другой репозиторий,
 * адрес или ветку, снимают защиту или стирают общее: `git -c` с ними и их
 * запись — человеку. Прочие ключи (`core.commitGraph`, `fetch.unpackLimit`,
 * `core.protectNTFS`, `maintenance.auto`…) не делают ни того, ни другого — сами
 * (ревью 23.10: 14 ложных карточек на `-c` в корпусе из 14 509 команд).
 *
 * - программа: `core.fsmonitor`/`sshCommand`/`askPass`/`gitProxy`/
 *   `alternateRefsCommand`, `diff.external`, `diff.*.textconv|command`,
 *   драйверы слияния и фильтры, `credential.*`, `alias.*`, `uploadpack.*`/
 *   `receivepack.*`, `gpg.*program|command`, `hook.*`, `submodule.*`
 *   (`update=!cmd`), `sendemail`/`imap`/`browser`/`web`/`man`/`instaweb`,
 *   `interactive.diffFilter`, `lfs.*`;
 * - куда: `remote.*`, `url.*`, `branch.*.remote|pushRemote|merge`, `push.*`
 *   (`push.default=matching` уведёт голый пуш и в main, `push.pushOption` —
 *   слияние MR на форже), прокси, `core.worktree`/`core.bare`;
 * - защита и общее: `core.hooksPath` (кроме отключения хуков на одну команду —
 *   `disablesHooks`, решение владельца 23.10 по F-75), `include*`,
 *   `init.templateDir`, `protocol.*allow` (`ext::`), `safe.*`, `trace2.*`
 *   (пишет файл), `gc.*Expire`/`gc.rerere*` (стирают общее хранилище).
 *
 * Пейджер — только `cat`/`less`, редактор — только «ничего не открывать»:
 * `core.editor=./x.sh` исполнил бы файл при `commit`.
 */
const RISKY_CONFIG_KEY = new RegExp(
  `^(${[
    'core\\.(fsmonitor|sshcommand|hookspath|askpass|gitproxy|worktree|bare|alternaterefs\\w*)',
    'diff\\.external',
    'diff\\..+\\.(textconv|command)',
    '(diff|merge)\\.(gui)?tool',
    '(diff|merge)tool\\..+',
    'merge\\..+\\.(driver|recursive)',
    'filter\\..+',
    'credential(\\..+)?',
    'alias\\..+',
    '(uploadpack|receivepack|uploadarchive)\\..+',
    'remote\\..+',
    'url\\..+',
    'branch\\..+\\.(remote|pushremote|merge)',
    'push\\..+',
    '.+\\.proxy',
    'gpg\\..*(program|command)',
    'protocol(\\..+)?\\.allow',
    'include\\..+',
    'includeif\\..+',
    'init\\.templatedir',
    'hook\\..+',
    'submodule\\..+',
    '(sendemail|imap|browser|web|man|instaweb|trace2|safe|lfs)\\..+',
    'interactive\\.difffilter',
    'gc\\.(\\w*expire\\w*|rerere\\w*)',
  ].join('|')})$`,
  'i',
);
const SAFE_PAGER = /^(core\.pager|pager\.[^=]+)=(cat|less( -\S+)*|false|true)?$/i;
const SAFE_EDITOR = /^(core\.editor|sequence\.editor)=(true|:|false|cat)?$/i;

/**
 * Ключи, которые группа может ЗАПИСАТЬ в настройки своей копии сверх безопасных
 * для `-c`: поведение pull/rebase/merge без программ и без смены удалённого.
 * `branch.*.remote`/`pushRemote`, `remote.*`, `push.default` здесь нет: они
 * уводят пуш без явной цели в другое место.
 */
const SAFE_WRITE_KEY =
  /^(pull\.(rebase|ff)|push\.autosetupremote|rebase\.(autostash|autosquash|updaterefs)|merge\.ff|fetch\.prune|rerere\.(enabled|autoupdate)|core\.(ignorecase|filemode)|branch\.[\w./-]+\.(merge|rebase|description))$/i;

/** `-c ключ=значение` перед подкомандой (и запись того же ключа): безопасен ли. */
export function safeConfigPair(text: string): boolean {
  const at = text.indexOf('=');
  const key = at < 0 ? text : text.slice(0, at);
  if (!/^[a-z][\w-]*(\..+)?\.[\w-]+$/i.test(key)) return false;
  if (/^(core\.(pager|editor)|sequence\.editor|pager\..+)$/i.test(key)) {
    return SAFE_PAGER.test(text) || SAFE_EDITOR.test(text);
  }
  // Ссылки из дерева на диск (аудит 23.10, A-09): ссылка наружу легла бы мимо
  // копии. `core.protectNTFS=false` — обычная выкладка путей, которых NTFS не
  // знает (сотни прогонов групп), её не трогаем.
  if (/^core\.symlinks$/i.test(key)) return /^[^=]+=(false|no|off|0)$/i.test(text);
  return !RISKY_CONFIG_KEY.test(key);
}

/**
 * `-c core.hooksPath=/dev/null` (пусто, `NUL` на Windows) на одну команду — то же,
 * что `--no-verify`, который группе разрешён (решение владельца 23.10): хуки
 * репозитория не идут, а проверки сдачи панель гонит сама (`sieve-gate.ts`,
 * `split-recheck.ts`). Любой другой путь исполнил бы хуки из произвольного
 * каталога — карточка. `NUL` — только на Windows: там это устройство, а на
 * Linux и macOS — каталог `./NUL`, который агент мог завести сам. Запись того
 * же ключа в настройки (`git config core.hooksPath …`) сюда не входит: она
 * переживает команду и общая у всех копий репозитория.
 */
export function disablesHooks(text: string, platform: string = process.platform): boolean {
  const match = /^core\.hookspath=(.*)$/i.exec(text);
  if (!match) return false;
  const value = match[1] as string;
  return value === '' || value === '/dev/null' || (platform === 'win32' && /^nul$/i.test(value));
}

/** `git config --get x`, `git config --list`, `git config get x` — чтение настроек. */
export function configReads(args: Word[]): boolean {
  if (args.some((arg) => arg.dynamic)) return false;
  const texts = args.map((arg) => arg.text);
  const reads =
    texts.some((text) =>
      /^(--get(-all|-regexp|-urlmatch|-color|-colorbool)?|--list|-l)$/.test(text),
    ) ||
    texts[0] === 'get' ||
    texts[0] === 'list';
  const edits = texts.some((text) =>
    /^(--(add|unset(-all)?|replace-all|rename-section|remove-section|edit)|-e)$/.test(text),
  );
  return reads && !edits;
}

const CONFIG_FLAG =
  /^(--local|--worktree|--bool|--int|--path|--bool-or-int|--expiry-date|--type=\S+|--no-type|--null|-z|--fixed-value|--all|--comment=.*|--show-origin|--show-scope|--name-only|--default=.*)$/;
const CONFIG_WRITE_FLAG = /^(--add|--replace-all|--unset|--unset-all)$/;
/** Чужой файл настроек: читать можно, писать — человеку. */
const CONFIG_SCOPE = /^(--global|--system|--includes|--no-includes|--file=.*|--blob=.*)$/;
const CONFIG_SCOPE_VALUED = /^(--file|-f|--blob)$/;
const CONFIG_EDITS = /^(--edit|-e|--rename-section|--remove-section)$/;

/**
 * `git config` в копии или пробном репозитории: чтение — рутина, и голым ключом
 * (`git config core.hooksPath`, ревью 23.10: ложная карточка) тоже; запись
 * ключа, что запускает программу или уводит git (`RISKY_CONFIG_KEY`:
 * `core.fsmonitor`, `core.hooksPath`, `alias.*`, `diff.external`, `remote.*.url`,
 * `include.path`, `credential.helper`), запись в чужой файл настроек и правка
 * редактором — человеку: следующий же `git status` исполнил бы записанную
 * программу. Запись прочего ключа — правилам чата, как прежде.
 */
export function configVerdict(args: Word[]): SegmentVerdict {
  if (configReads(args)) return ROUTINE;
  const positional: string[] = [];
  let foreign = false;
  let writes = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    if (arg.dynamic) return DANGER;
    const text = arg.text;
    if (CONFIG_EDITS.test(text)) return DANGER;
    if (CONFIG_SCOPE.test(text) || CONFIG_SCOPE_VALUED.test(text)) {
      foreign = true;
      if (CONFIG_SCOPE_VALUED.test(text)) {
        const file = args[i + 1];
        if (!file || file.dynamic) return DANGER;
        i += 1;
      }
      continue;
    }
    if (text === '--type') {
      i += 1;
      continue;
    }
    if (CONFIG_WRITE_FLAG.test(text)) {
      writes = true;
      continue;
    }
    if (CONFIG_FLAG.test(text)) continue;
    if (text.startsWith('-')) return DANGER;
    positional.push(text);
  }
  // Новая запись команды: `git config set ключ значение`, `git config unset ключ`.
  if (/^(rename-section|remove-section|edit)$/.test(positional[0] ?? '')) return DANGER;
  if (/^(set|unset)$/.test(positional[0] ?? '')) writes = true;
  const words = /^(set|unset)$/.test(positional[0] ?? '') ? positional.slice(1) : positional;
  const key = words[0];
  if (key === undefined) return OTHER;
  const value = words[1];
  // Один ключ без значения и без флага записи — чтение, в какой бы файл ни смотрело.
  if (!writes && value === undefined && words.length === 1) return ROUTINE;
  if (foreign) return DANGER;
  // `status.showUntrackedFiles no` прятал новые файлы от чтения дерева перед
  // затиранием — снимок не снимался (ревью 23.10, A-10). Сторож теперь читает с
  // `--untracked-files=all`, но запись `status.*` судит человек.
  if (/^status\./i.test(key)) return DANGER;
  const pair = value === undefined ? key : `${key}=${value}`;
  return safeConfigPair(pair) || SAFE_WRITE_KEY.test(key) ? OTHER : DANGER;
}

/**
 * Ключи, которые назначают программу, — полными именами (`long`), и короткие
 * (`run`) среди склеенных (`-qu./x.sh`): буквы из `value` берут остаток слова
 * значением, и после них склейка кончается (`-bux` — ветка `ux`).
 */
interface ProgramOptions {
  long: readonly string[];
  run?: string;
  value?: string;
}

const REMOTE_PROGRAM: ProgramOptions = { long: ['upload-pack', 'receive-pack', 'exec'] };

const PROGRAM_OPTIONS = new Map<string, ProgramOptions>(
  Object.entries({
    fetch: REMOTE_PROGRAM,
    pull: REMOTE_PROGRAM,
    push: REMOTE_PROGRAM,
    remote: REMOTE_PROGRAM,
    archive: REMOTE_PROGRAM,
    'send-pack': REMOTE_PROGRAM,
    'fetch-pack': REMOTE_PROGRAM,
    'ls-remote': { long: ['upload-pack', 'exec'], run: 'u', value: 'o' },
    // Настройки (`-c`, `--config`) и крючки (`--template`) новой копии.
    clone: { long: ['upload-pack', 'config', 'template'], run: 'uc', value: 'boj' },
    init: { long: ['template'] },
    // `-x <команда>`; `-X` — стратегия, `-s`/`-C` — со значением.
    rebase: { long: ['exec'], run: 'x', value: 'sXC' },
    difftool: { long: ['extcmd'], run: 'x', value: 't' },
    mergetool: { long: ['extcmd'], run: 'x', value: 't' },
    // `-O<pager>` открывает найденные файлы программой (RF-BGCD-01).
    grep: { long: ['open-files-in-pager'], run: 'O', value: 'efABCm' },
  }),
);

/**
 * Ключ назван полным именем или его началом: git принимает любое начало
 * длинного ключа (`--exe` — `--exec`, `--upload-pa=` — `--upload-pack=`), а
 * неоднозначное отвергает сам — такое тоже считаем запуском (RF-BGCD-01).
 */
function namesProgram(text: string, options: ProgramOptions): boolean {
  if (text.startsWith('--')) {
    const flag = text.split('=')[0] as string;
    return flag.length > 2 && options.long.some((name) => `--${name}`.startsWith(flag));
  }
  if (!options.run || !/^-[^-]/.test(text)) return false;
  for (const letter of text.slice(1)) {
    if (options.run.includes(letter)) return true;
    if (options.value?.includes(letter)) return false;
  }
  return false;
}

/**
 * Подкоманда или ключ запускают программу, которую назвала команда: `rebase -x`,
 * `submodule foreach`, `bisect run`, `difftool -x`, `fetch --upload-pack=…`,
 * `grep -O`, адрес `ext::…`, `clone -c`/`init --template` (настройки и крючки
 * новой копии), `filter-branch` (фильтры — команды оболочки), `hook run`.
 */
export function runsProgram(sub: string, args: Word[]): boolean {
  const texts = args.map((arg) => arg.text);
  if (texts.some((text) => /^(ext|fd)::/i.test(text))) return true;
  const options = PROGRAM_OPTIONS.get(sub);
  if (options) return texts.some((text) => namesProgram(text, options));
  switch (sub) {
    case 'submodule':
      return texts.includes('foreach');
    case 'bisect':
      return texts[0] === 'run';
    case 'filter-branch':
    case 'filter-repo':
    case 'hook':
    case 'daemon':
    case 'instaweb':
    case 'web--browse':
    case 'send-email':
      return true;
    default:
      return false;
  }
}

/**
 * Длинный ключ или его сокращение, которое git примет (`--del` — `--delete`):
 * у git любая однозначная начальная часть длинного ключа — он сам (A-21).
 */
export function longFlag(text: string, name: string, shortest: number): boolean {
  const flag = text.split('=')[0] as string;
  return flag.length >= shortest + 2 && `--${name}`.startsWith(flag);
}

/** Флаг удаления: короткий с буквой (`-d`, `-D`, `-df`, `-rd`) или `--delete` с сокращениями. */
export function deleteFlag(text: string, letters: RegExp): boolean {
  return longFlag(text, 'delete', 1) || (/^-[a-zA-Z]+$/.test(text) && letters.test(text));
}

export function deletes(args: Word[], letters: RegExp): boolean {
  return args.some((arg) => deleteFlag(arg.text, letters));
}

/** Короткие ключи пуша до `-o<значение>`: `-fd`, `-df`, `-qd` — удаление (A-21). */
function pushDeletes(text: string): boolean {
  if (!/^-[a-zA-Z0-9]/.test(text)) return false;
  return (text.slice(1).split('o')[0] as string).includes('d');
}

/** `git branch` с переносом или копией поверх существующей: `-M`, `-m -f`, `--move --force`. */
function branchOverwrites(texts: readonly string[]): boolean {
  const short = (letter: string) =>
    texts.some((text) => /^-[a-zA-Z]+$/.test(text) && text.includes(letter));
  const moves =
    short('m') || short('c') || texts.some((t) => longFlag(t, 'move', 2) || longFlag(t, 'copy', 3));
  return moves && (short('f') || texts.some((text) => longFlag(text, 'force', 2)));
}

/** Снимки незакоммиченного, что панель кладёт перед затиранием (`git-snapshot.ts`). */
export const BACKUP_PREFIX = 'refs/agentdeck/backup/';

/**
 * Удаление средствами git и слияние (решение владельца 23.10: «запрещено
 * удаление чего угодно в плане гитовых операций и мержить — даже если это не
 * группа, а одиночная задача»). Здесь — только узнать форму: одиночный чат
 * отдаёт её человеку целиком, у группы звено решает `git-verdict.ts` (уборка
 * своей копии там — со снимком).
 */
export function destroysOrMerges(sub: string, args: Word[]): boolean {
  const texts = args.map((arg) => arg.text);
  const dryRun = texts.some((text) => /^(-n|--dry-run)$/.test(text));
  const first = texts[0];
  switch (sub) {
    case 'merge':
      return !texts.some((text) => /^--(abort|quit|continue)$/.test(text));
    case 'send-pack':
    case 'push':
      // Склеенные (`-fd`) и сокращённые (`--del`, `--pru`, `--mir`) — то же (A-21).
      return texts.some(
        (text) =>
          pushDeletes(text) ||
          longFlag(text, 'delete', 1) ||
          longFlag(text, 'prune', 3) ||
          longFlag(text, 'mirror', 1) ||
          /^\+?:/.test(text),
      );
    case 'branch':
      // `-M`/`-C` — перенос и копия поверх существующей ветки: та пропадает
      // вместе со своим журналом, как при `-D` (у группы это тоже карточка);
      // `-m -f`, `--move --force` — они же. `-f <ветка> <куда>` переставляет
      // существующую ветку — её коммиты уходят, как при `-C` (A-24).
      return (
        deletes(args, /[dDMC]/) ||
        branchOverwrites(texts) ||
        texts.some((text) => text === '-f' || longFlag(text, 'force', 2))
      );
    case 'tag':
      return deletes(args, /d/);
    case 'stash':
      return first === 'drop' || first === 'clear';
    case 'clean':
      return !dryRun;
    case 'worktree':
      return first === 'remove' || first === 'prune';
    case 'update-ref':
      // Команды из потока (`--stdin`) не видны до исполнения: там может быть
      // `delete refs/heads/…` — считаем удалением.
      if (texts.includes('--stdin')) return true;
      // Перезапись своей ветки (`update-ref refs/heads/x <коммит>`) уносит её
      // коммиты, как `branch -f` (A-24).
      if (texts.some((text) => text.startsWith('refs/heads/'))) return true;
      return deletes(args, /d/) && !dropsOnlyRefetchable(texts);
    case 'symbolic-ref':
    case 'replace':
      return deletes(args, /d/);
    case 'reflog':
      return first === 'expire' || first === 'delete';
    case 'gc':
      return texts.some((text) => /^--prune(=|$)/.test(text));
    case 'prune':
      return !dryRun;
    case 'filter-branch':
    case 'filter-repo':
      return true;
    case 'notes':
      return first === 'remove' || first === 'prune';
    case 'remote':
      return first === 'remove' || first === 'rm';
    case 'submodule':
      return texts.includes('deinit');
    default:
      return false;
  }
}

/**
 * `update-ref -d <ссылка> [<старое>]` убирает только то, что возвращается само:
 * следящую ссылку удалённого (`refs/remotes/…`, её вернёт следующий `fetch`) —
 * как у группы (`updateRefVerdict`). Снимок панели (`git-snapshot.ts`) сам не
 * вернётся: его удаление — потеря того, что снимок берёг (ревью 23.10, A-17).
 * Удаляемая ссылка — первая позиционная: `старое` после неё
 * только сверяется, и `-d refs/heads/main refs/remotes/o/x` — удаление main.
 */
function dropsOnlyRefetchable(texts: readonly string[]): boolean {
  const named: string[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    const text = texts[i] as string;
    if (text === '-m') i += 1;
    else if (!text.startsWith('-')) named.push(text);
  }
  const [ref, , extra] = named;
  if (!ref || extra !== undefined) return false;
  return REMOTE_TRACKING.test(ref);
}

/** Ссылки, которые у каждой копии свои: `HEAD` копии, bisect, `refs/worktree/*`. */
const PER_WORKTREE_REF = /^refs\/(bisect|worktree|rewritten)\//;

/** Следящая ссылка удалённого: `refs/remotes/origin/ветка`, без подъёма `..`. */
const REMOTE_TRACKING = /^refs\/remotes\/[\w.-]+\/(?!.*(^|\/)\.\.?(\/|$))[^\s\0]+$/;

/**
 * Подкоманды над ссылками и хранилищем, общими для всех копий репозитория:
 * журнал ссылок, сборка мусора, подмены, символические ссылки, прямая запись
 * ссылки. `undefined` — не эта подкоманда. Своя ветка (по git копии, не из
 * текста) переписывается строкой «история git»; прочее — человеку: `update-ref
 * refs/remotes/origin/main` двигает и то, по чему панель сверяет конфликт MR.
 */
export function sharedRefsVerdict(
  sub: string,
  args: Word[],
  walk: Walk,
  cwd: string | undefined,
): SegmentVerdict | undefined {
  const texts = args.map((arg) => (arg.dynamic ? '\0' : arg.text));
  const first = texts[0];
  switch (sub) {
    case 'filter-branch':
    case 'filter-repo':
      return DANGER;
    case 'reflog':
      if (first === 'expire' || first === 'delete') return DANGER;
      return first === undefined || /^(show|exists|list)$/.test(first) ? ROUTINE : OTHER;
    case 'gc':
      return texts.some((text) => text === '\0' || /^--prune(=|$)/.test(text)) ? DANGER : OTHER;
    case 'prune':
      return texts.some((text) => /^(-n|--dry-run)$/.test(text)) ? ROUTINE : DANGER;
    case 'repack':
      return deletes(args, /d/) ? DANGER : OTHER;
    case 'replace':
      return texts.length === 0 || texts.some((text) => /^(-l|--list)$/.test(text))
        ? ROUTINE
        : DANGER;
    case 'symbolic-ref':
      return symbolicRefVerdict(texts, walk, cwd);
    case 'update-ref':
      return updateRefVerdict(texts, walk, cwd);
    case 'notes': {
      if (first === 'remove' || first === 'prune') return DANGER;
      return first === undefined || /^(list|show)$/.test(first) ? ROUTINE : OTHER;
    }
    case 'remote':
      // Сменить адрес `origin` — увести каждый следующий «пуш в origin» мимо разбора.
      return /^(set-url|rename|remove|rm|set-head)$/.test(first ?? '') ? DANGER : undefined;
    case 'submodule':
      return texts.includes('deinit') ? DANGER : undefined;
    default:
      return undefined;
  }
}

/**
 * `git symbolic-ref HEAD refs/heads/x` — смена ветки без `checkout` (RF-BGCD-02):
 * git не проверяет, что `x` уже стоит в другой копии, и следующий коммит ляжет
 * в чужую ветку (в `main` основной копии). Своя ветка — строкой «история git»,
 * любая другая — человеку; обход ведёт HEAD дальше, и `git push origin HEAD`
 * следом судится по новой ветке. `-qd HEAD` — удаление (A-25).
 */
function symbolicRefVerdict(texts: string[], walk: Walk, cwd: string | undefined): SegmentVerdict {
  if (texts.some((text) => deleteFlag(text, /d/))) return DANGER;
  const positional: string[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    const text = texts[i] as string;
    if (text === '-m') i += 1;
    else if (!text.startsWith('-')) positional.push(text);
  }
  const [ref, target, extra] = positional;
  if (target === undefined) return ROUTINE;
  if (ref !== 'HEAD' || extra !== undefined) return DANGER;
  const name = target.startsWith('refs/heads/') ? target.slice('refs/heads/'.length) : undefined;
  const own = name !== undefined && walk.ownBranchAt(cwd) === name;
  walk.moveHead(name, cwd);
  return own ? OTHER : DANGER;
}

/**
 * `git update-ref <ссылка> <новое> [<старое>]`: своя ветка и `HEAD` своей ветки
 * — строкой «история git»; ссылки самой копии — тоже; удаление (`-d`) —
 * следящих ссылок `refs/remotes/*` (их вернёт следующий `fetch`; ревью 23.10:
 * 9 ложных карточек на уборке устаревших `refs/remotes/origin/…`); снимок
 * панели (`refs/agentdeck/backup/…`), `--stdin` и любая другая ссылка —
 * человеку: удалив снимок, группа сотрёт то, что он берёг (A-17).
 */
function updateRefVerdict(texts: string[], walk: Walk, cwd: string | undefined): SegmentVerdict {
  if (texts.includes('\0')) return DANGER;
  if (texts.some((text) => /^(-d|--delete)$/.test(text))) {
    if (texts.some((text) => /^(--stdin|-z)$/.test(text))) return DANGER;
    const named = texts.filter((text) => !/^(-d|--delete|--no-deref)$/.test(text));
    const [ref, old, extra] = named;
    if (!ref || extra !== undefined || (old !== undefined && old.startsWith('-'))) return DANGER;
    return REMOTE_TRACKING.test(ref) && walk.inCopy(cwd) ? OTHER : DANGER;
  }
  const positional: string[] = [];
  for (let i = 0; i < texts.length; i += 1) {
    const text = texts[i] as string;
    if (text === '-m') {
      i += 1;
      continue;
    }
    if (/^(--no-deref|--create-reflog|-z)$/.test(text)) continue;
    if (text.startsWith('-')) return DANGER;
    positional.push(text);
  }
  const ref = positional[0];
  if (!ref || positional.length < 2) return DANGER;
  if (ref === 'HEAD') {
    const verdict = walk.ownBranchAt(cwd) ? OTHER : DANGER;
    // `--no-deref` пишет сам HEAD: голова отсоединена, своей ветки дальше нет (RF-BGCD-02).
    if (texts.includes('--no-deref')) walk.moveHead(DETACHED, cwd);
    return verdict;
  }
  if (PER_WORKTREE_REF.test(ref)) return OTHER;
  return ref.startsWith('refs/heads/') && ownsBranch(walk, cwd, ref.slice('refs/heads/'.length))
    ? OTHER
    : DANGER;
}

/**
 * Что звено git сделает с незакоммиченным в копии (решения владельца 23.10):
 * - `discard` — сотрёт правки или новые файлы (`reset --hard`, `checkout -- пути`,
 *   `checkout -f`, `restore пути`, `switch --discard-changes`, `clean -f`,
 *   `rm -f`): само, но сперва панель снимает их в `refs/agentdeck/backup/…`
 *   (`git-snapshot.ts`);
 * - `switch` — смена ветки: правки уехали бы на другую ветку или затёрлись,
 *   поэтому на грязном дереве — отказ «сперва доделай и закоммить».
 */
export type GitDiscard = 'discard' | 'switch';

export interface GitEffects {
  discards: GitDiscard[];
  /** Удаление данных git или слияние — для одиночного чата (`destroysOrMerges`). */
  destroys: boolean;
}

/**
 * Собиратель на время одного разбора. Признаки не идут через итог звена: его
 * тип и свёртку (`walk.ts`, `group-command.ts`) ведёт другой модуль, а разбор
 * синхронный — собиратель вокруг одного вызова не смешивает команды.
 */
let sink: (GitEffects & { recorded: readonly string[] }) | undefined;

/**
 * `recorded` — ветка группы из записи разделения: тоже своя, хотя копия может
 * стоять на временной (`git branch -f <своя> HEAD` с пересборочной ветки —
 * карточка 23.10, разрешена владельцем).
 */
export function collectGitEffects<T>(
  judge: () => T,
  recorded: readonly string[] = [],
): GitEffects & { result: T } {
  const outer = sink;
  const mine = { discards: [] as GitDiscard[], destroys: false, recorded };
  sink = mine;
  try {
    const result = judge();
    return { result, discards: mine.discards, destroys: mine.destroys };
  } finally {
    sink = outer;
  }
}

/**
 * Своя ли ветка для перестановки (`branch -f`, `checkout -B`, `update-ref`):
 * та, на которой копия по git, или ветка группы из записи разделения. Основная
 * и защищённая — никогда.
 */
export function ownsBranch(walk: Walk, cwd: string | undefined, name: string): boolean {
  if (!walk.inCopy(cwd) || isProtectedBranch(name, walk.base)) return false;
  return (
    name === walk.ownBranchAt(cwd) ||
    walk.isOwnBranch(name) ||
    sink?.recorded.includes(name) === true
  );
}

export function noteDestroys(): void {
  if (sink) sink.destroys = true;
}

export function noteDiscard(discard: GitDiscard): void {
  sink?.discards.push(discard);
}
