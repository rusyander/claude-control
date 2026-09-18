import {
  BRANCH_FORBIDDEN,
  COMMIT_MESSAGE_MAX,
  CONTROL_CHARS,
  GIT_NETWORK_TIMEOUT_MS,
} from './constants.ts';
import { GitError, git, gitOutput, type GitOutput } from './exec.ts';
import { requireRepo } from './read.ts';
import { coded } from '../../lib/server-text.ts';

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
  if (!value) throw coded(new GitError('Имя ветки не задано'), 'branch-name-empty');
  if (value.length > 200)
    throw coded(new GitError('Имя ветки слишком длинное'), 'branch-name-too-long');
  if (value.startsWith('-'))
    throw coded(new GitError('Имя ветки не может начинаться с дефиса'), 'branch-name-dash');
  if (BRANCH_FORBIDDEN.test(value)) {
    throw coded(
      new GitError('В имени ветки не должно быть пробелов и управляющих символов'),
      'branch-name-spaces',
    );
  }
  try {
    await git(projectDir, ['check-ref-format', '--branch', value]);
  } catch {
    throw coded(
      new GitError(`git не принимает такое имя ветки: ${value}`),
      'branch-name-rejected',
      { value },
    );
  }
}

/**
 * Переключиться на СУЩЕСТВУЮЩУЮ локальную ветку. Имя сверяется со списком, а не
 * передаётся в git как есть: `checkout <произвольная ссылка>` отцепил бы HEAD.
 * `--` в конце снимает двусмысленность «ветка или файл с таким же именем».
 */
export async function checkoutBranch(projectDir: string, branch: string): Promise<GitOutput> {
  const info = await requireRepo(projectDir);
  const value = branch.trim();
  if (!info.branches.includes(value)) {
    throw coded(new GitError(`Ветки ${value} нет среди локальных`), 'branch-not-local', { value });
  }
  if (value === info.branch)
    return {
      output: `Уже на ветке ${value}`,
      outputCode: 'git-already-on-branch',
      outputParams: { value },
    };
  const out = await git(projectDir, ['checkout', value, '--']);
  return gitOutput(out, `Переключено на ветку ${value}`, 'git-switched-branch', { value });
}

/**
 * Создать ветку от текущего HEAD и перейти на неё. Незакоммиченные правки git
 * переносит сам — это его обычное поведение, и панель его не подменяет.
 */
export async function createBranch(projectDir: string, name: string): Promise<GitOutput> {
  const info = await requireRepo(projectDir);
  const value = name.trim();
  await assertBranchName(projectDir, value);
  if (info.branches.includes(value))
    throw coded(new GitError(`Ветка ${value} уже существует`), 'branch-exists', { value });
  if (info.unborn) {
    throw coded(
      new GitError('В репозитории ещё нет коммитов — сначала сделайте первый коммит'),
      'git-no-commits-first',
    );
  }
  const out = await git(projectDir, ['checkout', '-b', value]);
  return gitOutput(out, `Создана ветка ${value}`, 'git-branch-created', { value });
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
export async function pullChanges(projectDir: string, branch?: string): Promise<GitOutput> {
  const info = await requireRepo(projectDir);
  if (info.unborn) {
    throw coded(
      new GitError('В репозитории ещё нет коммитов — тянуть некуда'),
      'git-no-commits-pull',
    );
  }
  const value = branch?.trim();

  if (!value) {
    if (info.detached) {
      throw coded(
        new GitError('HEAD отцеплен от ветки — переключитесь на ветку или выберите её в списке'),
        'git-head-detached-pull',
      );
    }
    const out = await git(projectDir, ['pull'], GIT_NETWORK_TIMEOUT_MS);
    return gitOutput(out, 'Обновлено', 'git-pulled');
  }

  if (!info.remote) {
    throw coded(
      new GitError('У репозитория нет удалённых — тянуть неоткуда'),
      'git-no-remote-pull',
    );
  }
  if (!info.remoteBranches.includes(value)) {
    throw coded(new GitError(`Ветки ${value} нет на ${info.remote}`), 'branch-not-on-remote', {
      value,
      remote: info.remote,
    });
  }
  const out = await git(projectDir, ['pull', info.remote, value], GIT_NETWORK_TIMEOUT_MS);
  return gitOutput(out, `Обновлено из ${info.remote}/${value}`, 'git-pulled-from', {
    source: `${info.remote}/${value}`,
  });
}

/**
 * Отправить текущую ветку. Без upstream — `push --set-upstream <remote> <ветка>`,
 * с ним — голый `git push`: он сам знает, куда. Ветка берётся из ответа git, а
 * не из запроса, поэтому отправить чужую ветку этой кнопкой нельзя.
 *
 * Отсутствие upstream видно по `ahead`: его считают только при нём.
 */
export async function pushBranch(projectDir: string): Promise<GitOutput> {
  const info = await requireRepo(projectDir);
  if (info.unborn)
    throw coded(
      new GitError('В репозитории ещё нет коммитов — отправлять нечего'),
      'git-no-commits-push',
    );
  if (info.detached) {
    throw coded(
      new GitError('HEAD отцеплен от ветки — переключитесь на ветку и повторите'),
      'git-head-detached',
    );
  }
  if (!info.branch) throw coded(new GitError('Текущая ветка не определена'), 'git-branch-unknown');
  if (!info.remote)
    throw coded(
      new GitError('У репозитория нет удалённых — отправлять некуда'),
      'git-no-remote-push',
    );

  const tracked = info.ahead !== undefined;
  const args = tracked ? ['push'] : ['push', '--set-upstream', info.remote, info.branch];
  const out = await git(projectDir, args, GIT_NETWORK_TIMEOUT_MS);
  return tracked
    ? gitOutput(out, `Отправлено в ${info.remote}`, 'git-pushed', { remote: info.remote })
    : gitOutput(out, `Ветка ${info.branch} отправлена в ${info.remote}`, 'git-pushed-branch', {
        branch: info.branch,
        remote: info.remote,
      });
}

/**
 * Закоммитить ВСЕ изменения рабочего дерева: `add -A`, затем `commit -m`.
 * Выборочного индекса в панели нет намеренно — это работа для полноценного
 * git-клиента, а здесь пульт на три кнопки.
 */
export async function commitAll(projectDir: string, message: string): Promise<GitOutput> {
  const info = await requireRepo(projectDir);
  const text = message.trim();
  if (!text) throw coded(new GitError('Сообщение коммита пустое'), 'commit-message-empty');
  if (text.length > COMMIT_MESSAGE_MAX) {
    throw coded(
      new GitError(`Сообщение коммита длиннее ${COMMIT_MESSAGE_MAX} символов`),
      'commit-message-too-long',
      { max: COMMIT_MESSAGE_MAX },
    );
  }
  if (CONTROL_CHARS.test(text)) {
    throw coded(
      new GitError('В сообщении коммита есть управляющие символы'),
      'commit-message-control',
    );
  }
  if (info.dirtyCount === 0)
    throw coded(new GitError('Нечего коммитить — изменений нет'), 'commit-nothing');

  await git(projectDir, ['add', '-A']);
  const out = await git(projectDir, ['commit', '-m', text]);
  return gitOutput(out, 'Коммит создан', 'git-committed');
}
