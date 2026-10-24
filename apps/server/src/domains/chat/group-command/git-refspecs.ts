import type { Word } from './shell-parse.ts';
import { DANGER, ROUTINE, isProtectedBranch, type SegmentVerdict, type Walk } from './walk.ts';

/**
 * Подкоманды git со спецификациями ссылок (`источник:приёмник`): пуш и
 * загрузка. Вынесено из `git-verdict.ts` по размеру.
 */

const PUSH_QUIET_FLAGS = new Set([
  '-u',
  '--set-upstream',
  '--force-if-includes',
  '-q',
  '--quiet',
  '-v',
  '--verbose',
  '--progress',
  '--no-progress',
  '--porcelain',
  '--no-verify',
  '--verify',
  '--tags',
  '--follow-tags',
  '--no-follow-tags',
  '--atomic',
  '--no-atomic',
  '-n',
  '--dry-run',
]);

/**
 * Ветка, в которую git запишет `ref` на удалённом: `refs/heads/x` и `heads/x`
 * (правило DWIM `refs/%s`) — это `x`; иные `refs/…` (метки, заметки) остаются
 * как есть. Раньше `HEAD:heads/main` судился как ветка `heads/main` и уходил в
 * main сам (ревью 23.10, R-03).
 */
function branchName(ref: string): string {
  for (const prefix of ['refs/heads/', 'heads/']) {
    if (ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return ref;
}

/**
 * Пуш: в `origin`, без `+`/`:ветки`/`--delete`/`-o`, каждая цель — не
 * основная и не защищённая ветка. Перезапись (`--force-with-lease`, `--force`,
 * `-f`) — только своей ветки, которую копия держит по git, и только её; вместе
 * с метками (`--tags`, `--follow-tags`) — человеку: принудительно уехали бы и
 * все метки, общие для всех. Обычный пуш своей или другой рабочей ветки —
 * рутина: перемотка вперёд ничью работу не стирает (политика владельца 19.10).
 */
export function pushVerdict(args: Word[], walk: Walk, cwd: string | undefined): SegmentVerdict {
  const current = walk.branchAt(cwd);
  const own = walk.ownBranchAt(cwd);
  const base = walk.base;
  let lease = false;
  let tags = false;
  const leaseRefs: string[] = [];
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.dynamic) return DANGER;
    const text = arg.text;
    // `--force`/`-f` своей ветки — то же, что аренда (решение владельца 23.10):
    // переписать СВОЮ ветку после rebase группе можно; на ветке MR под ревью это
    // решает маршрут прав по конфликту (`groupPushRefusal`), чужая цель — человеку.
    if (text === '--force-with-lease' || text === '--force' || text === '-f') {
      lease = true;
      continue;
    }
    if (text.startsWith('--force-with-lease=')) {
      lease = true;
      leaseRefs.push(branchName(text.slice('--force-with-lease='.length).split(':')[0] ?? ''));
      continue;
    }
    if (text === '--tags' || text === '--follow-tags') tags = true;
    if (PUSH_QUIET_FLAGS.has(text)) continue;
    if (text.startsWith('-')) return DANGER;
    positional.push(text);
  }
  const [remote, ...refspecs] = positional;
  if (remote !== undefined && remote !== 'origin') return DANGER;
  const targets: string[] = [];
  if (refspecs.length === 0) {
    if (!current) return DANGER;
    targets.push(current);
  }
  for (const refspec of refspecs) {
    // `+` — принудительно; `*` — шаблон: `refs/heads/*:refs/heads/*` уносит
    // все ветки, основную тоже, — какую из них заденет, по шаблону не судим.
    if (refspec.startsWith('+') || refspec.includes('*')) return DANGER;
    const [source = '', target, extra] = refspec.split(':');
    // `:ветка` — удаление ветки на удалённом.
    if (extra !== undefined || source === '') return DANGER;
    // `@` — то же, что `HEAD`; приёмник `HEAD` на удалённом — его ветка по умолчанию.
    const head = source === 'HEAD' || source === '@';
    if (target === 'HEAD' || target === '@') return DANGER;
    const to = target === undefined ? (head ? current : source) : target;
    if (!to) return DANGER;
    targets.push(branchName(to));
  }
  for (const target of targets) {
    if (target.startsWith('refs/') || isProtectedBranch(target, base)) return DANGER;
  }
  if (lease) {
    if (tags || !own) return DANGER;
    if (!targets.every((target) => target === own)) return DANGER;
    if (!leaseRefs.every((ref) => ref === own)) return DANGER;
  }
  return { kind: 'routine', writes: true, lease };
}

/**
 * Приёмник загрузки — локальная ветка (`refs/heads/x`, `heads/x`, просто `x`)
 * или снимок панели (`refs/agentdeck/…`). Следящие (`refs/remotes/…`) и
 * служебные ссылки (`refs/tmp/mr1`, `refs/merge-requests/…`) — нет.
 */
const sharedTarget = (target: string): boolean =>
  !target.startsWith('refs/') || /^refs\/(heads|agentdeck)\//.test(target);

/**
 * `git fetch` своей копии — рутина. Кроме записи в локальные ветки силой
 * (`+refs/heads/*:refs/heads/*`, `-f … main:main`), а с `--prune` — и удаления
 * веток, которых нет на удалённом: ветки у копий общие, так стёрлись бы
 * незапушенные коммиты чужих групп (холодная атака 23.10, рядом с R-03).
 */
export function fetchVerdict(args: Word[], walk: Walk, cwd: string | undefined): SegmentVerdict {
  if (forgesTracking(args, walk, cwd)) return DANGER;
  const forced = args.some((arg) => /^(-f|--force|-p|--prune)$/.test(arg.text));
  for (const arg of args) {
    const text = arg.text;
    if (text.startsWith('-') || !text.includes(':')) continue;
    const target = text.slice(text.indexOf(':') + 1);
    if (target === '' || !sharedTarget(target)) continue;
    if (arg.dynamic || forced || text.startsWith('+')) return DANGER;
  }
  return ROUTINE;
}

/** Ключи `fetch`/`pull` со значением отдельным словом: оно — не репозиторий. */
const FETCH_VALUED =
  /^(-j|-o|--jobs|--depth|--deepen|--shallow-since|--shallow-exclude|--upload-pack|--server-option|--negotiation-tip|--filter|--refmap|--recurse-submodules-default|--submodule-prefix|-s|--strategy|-X|--strategy-option)$/;

/** Имя удалённого из настроек (`origin`), а не путь, `.` или адрес. */
const REMOTE_NAME = /^(?!\.\.?$)[\w][\w.-]*$/;

/**
 * Загрузка подделывает следящую ссылку (RF-BGCD-05a): `git fetch .
 * +HEAD:refs/remotes/origin/main`, путь, `file://`, адрес или другое удалённое
 * пишут в `refs/remotes/<R>/…` не то, что лежит на `<R>`, — а по `origin/main`
 * панель судит, есть ли настоящий конфликт и что такое догон основной.
 * Приёмник `refs/remotes/<R>/…` — только из самого `<R>`, а основная, ветка по
 * умолчанию и своя ветка — только из одноимённой ветки там. Ключ `--refmap`
 * (`--refmap=+refs/heads/*:refs/remotes/origin/*`) судится как такой же приёмник.
 */
export function forgesTracking(args: Word[], walk: Walk, cwd: string | undefined): boolean {
  const positional: Word[] = [];
  const specs: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as Word;
    const text = arg.text;
    if (text.startsWith('--refmap=')) specs.push(text.slice('--refmap='.length));
    else if (text === '--refmap') {
      const value = args[i + 1];
      if (!value || value.dynamic) return true;
      specs.push(value.text);
    }
    if (FETCH_VALUED.test(text)) i += 1;
    else if (!text.startsWith('-')) positional.push(arg);
  }
  const [repository, ...refspecs] = positional;
  // Подстановка в приёмнике (`HEAD:$T`) — приёмник не проследить.
  const tracking = [...specs, ...refspecs.map((word) => word.text)].filter((spec) => {
    const target = spec.slice(spec.indexOf(':') + 1);
    return spec.includes(':') && (/^(refs\/)?remotes\//.test(target) || /[$`]/.test(target));
  });
  if (tracking.length === 0) return false;
  if (!repository || repository.dynamic || !REMOTE_NAME.test(repository.text)) return true;
  const own = walk.ownBranchAt(cwd) ?? walk.branchAt(cwd);
  return tracking.some((spec) => {
    const [source = '', target = ''] = spec.replace(/^\+/, '').split(':');
    const match = /^(?:refs\/)?remotes\/([^/]+)\/(.+)$/.exec(target);
    if (!match || match[1] !== repository.text) return true;
    const branch = match[2] as string;
    if (branch.includes('*')) return !/^(refs\/)?heads\/\*$/.test(source) || branch !== '*';
    const guarded = isProtectedBranch(branch, walk.base) || branch === own || branch === 'HEAD';
    return guarded && branchName(source) !== branch;
  });
}
