import {
  BRANCH_FORBIDDEN,
  COMMIT_MESSAGE_MAX,
  CONTROL_CHARS,
  GIT_NETWORK_TIMEOUT_MS,
} from './constants.ts';
import { git, GitError } from './exec.ts';
import { requireRepo } from './read.ts';

/**
 * Операции записи: переключение ветки, создание ветки, коммит, pull и push.
 * Ребейзов и удаления веток панель не делает намеренно.
 *
 * Push появился вместе с приложением на телефоне: закоммитить с дороги и не
 * иметь возможности отправить — половина работы. Отправляется ТОЛЬКО текущая
 * ветка и только вперёд: `--force` и явный refspec не передаются нигде, так что
 * чужую историю эта кнопка переписать не может.
 *
 * Сверх запуска без оболочки имя ветки проходит через `git check-ref-format
 * --branch` — это задокументированная проверка самого git, и придумывать свою
 * грамматику имён поверх неё незачем. Переключение разрешено только на
 * СУЩЕСТВУЮЩУЮ локальную ветку из списка: иначе `checkout <что угодно>` отцепил
 * бы HEAD на произвольный коммит, чего никто не просил.
 */

/**
 * Имя ветки проверяет сам git (`check-ref-format --branch`) — это его правила,
 * а не наши догадки. Дешёвая проверка перед этим отсекает пустое имя, пробелы и
 * ведущий дефис: последний git принял бы за флаг.
 */
export async function assertBranchName(projectDir: string, name: string): Promise<void> {
  const value = name.trim();
  if (!value) throw new GitError('Имя ветки не задано');
  if (value.length > 200) throw new GitError('Имя ветки слишком длинное');
  if (value.startsWith('-')) throw new GitError('Имя ветки не может начинаться с дефиса');
  if (BRANCH_FORBIDDEN.test(value)) {
    throw new GitError('В имени ветки не должно быть пробелов и управляющих символов');
  }
  try {
    await git(projectDir, ['check-ref-format', '--branch', value]);
  } catch {
    throw new GitError(`git не принимает такое имя ветки: ${value}`);
  }
}

/**
 * Переключиться на СУЩЕСТВУЮЩУЮ локальную ветку. Имя сверяется со списком, а не
 * передаётся в git как есть: `checkout <произвольная ссылка>` отцепил бы HEAD.
 * `--` в конце снимает двусмысленность «ветка или файл с таким же именем».
 */
export async function checkoutBranch(projectDir: string, branch: string): Promise<string> {
  const info = await requireRepo(projectDir);
  const value = branch.trim();
  if (!info.branches.includes(value)) {
    throw new GitError(`Ветки ${value} нет среди локальных`);
  }
  if (value === info.branch) return `Уже на ветке ${value}`;
  const out = await git(projectDir, ['checkout', value, '--']);
  return out.trim() || `Переключено на ветку ${value}`;
}

/**
 * Создать ветку от текущего HEAD и перейти на неё. Незакоммиченные правки git
 * переносит сам — это его обычное поведение, и панель его не подменяет.
 */
export async function createBranch(projectDir: string, name: string): Promise<string> {
  const info = await requireRepo(projectDir);
  const value = name.trim();
  await assertBranchName(projectDir, value);
  if (info.branches.includes(value)) throw new GitError(`Ветка ${value} уже существует`);
  if (info.unborn) {
    throw new GitError('В репозитории ещё нет коммитов — сначала сделайте первый коммит');
  }
  const out = await git(projectDir, ['checkout', '-b', value]);
  return out.trim() || `Создана ветка ${value}`;
}

/**
 * Подтянуть чужие коммиты. Без имени ветки — обычный `git pull` в текущей: он
 * сам знает свой upstream, и подставлять что-то вместо него панель не вправе.
 * С именем — `git pull <remote> <branch>`, причём имя обязано быть из списка
 * веток этого удалённого: как и у checkout, в git уходит только то, что git же
 * и перечислил, а не строка из запроса.
 *
 * Слияние здесь возможно, и это осознанно (см. заголовок домена). Конфликт —
 * не ошибка панели: git вернёт ненулевой код, его текст уйдёт пользователем как
 * есть, а рабочее дерево останется в конфликте до ручного разбора.
 */
export async function pullChanges(projectDir: string, branch?: string): Promise<string> {
  const info = await requireRepo(projectDir);
  if (info.unborn) {
    throw new GitError('В репозитории ещё нет коммитов — тянуть некуда');
  }
  const value = branch?.trim();

  if (!value) {
    if (info.detached) {
      throw new GitError(
        'HEAD отцеплен от ветки — переключитесь на ветку или выберите её в списке',
      );
    }
    const out = await git(projectDir, ['pull'], GIT_NETWORK_TIMEOUT_MS);
    return out.trim() || 'Обновлено';
  }

  if (!info.remote) {
    throw new GitError('У репозитория нет удалённых — тянуть неоткуда');
  }
  if (!info.remoteBranches.includes(value)) {
    throw new GitError(`Ветки ${value} нет на ${info.remote}`);
  }
  const out = await git(projectDir, ['pull', info.remote, value], GIT_NETWORK_TIMEOUT_MS);
  return out.trim() || `Обновлено из ${info.remote}/${value}`;
}

/**
 * Отправить текущую ветку. Без upstream — `push --set-upstream <remote> <ветка>`,
 * с ним — голый `git push`: он сам знает, куда. Ветка берётся из ответа git, а
 * не из запроса, поэтому отправить чужую ветку этой кнопкой нельзя.
 *
 * Отсутствие upstream видно по `ahead`: его считают только при нём.
 */
export async function pushBranch(projectDir: string): Promise<string> {
  const info = await requireRepo(projectDir);
  if (info.unborn) throw new GitError('В репозитории ещё нет коммитов — отправлять нечего');
  if (info.detached) {
    throw new GitError('HEAD отцеплен от ветки — переключитесь на ветку и повторите');
  }
  if (!info.branch) throw new GitError('Текущая ветка не определена');
  if (!info.remote) throw new GitError('У репозитория нет удалённых — отправлять некуда');

  const tracked = info.ahead !== undefined;
  const args = tracked ? ['push'] : ['push', '--set-upstream', info.remote, info.branch];
  const out = await git(projectDir, args, GIT_NETWORK_TIMEOUT_MS);
  return (
    out.trim() ||
    (tracked ? `Отправлено в ${info.remote}` : `Ветка ${info.branch} отправлена в ${info.remote}`)
  );
}

/**
 * Закоммитить ВСЕ изменения рабочего дерева: `add -A`, затем `commit -m`.
 * Выборочного индекса в панели нет намеренно — это работа для полноценного
 * git-клиента, а здесь пульт на три кнопки.
 */
export async function commitAll(projectDir: string, message: string): Promise<string> {
  const info = await requireRepo(projectDir);
  const text = message.trim();
  if (!text) throw new GitError('Сообщение коммита пустое');
  if (text.length > COMMIT_MESSAGE_MAX) {
    throw new GitError(`Сообщение коммита длиннее ${COMMIT_MESSAGE_MAX} символов`);
  }
  if (CONTROL_CHARS.test(text)) {
    throw new GitError('В сообщении коммита есть управляющие символы');
  }
  if (info.dirtyCount === 0) throw new GitError('Нечего коммитить — изменений нет');

  await git(projectDir, ['add', '-A']);
  const out = await git(projectDir, ['commit', '-m', text]);
  return out.trim() || 'Коммит создан';
}
