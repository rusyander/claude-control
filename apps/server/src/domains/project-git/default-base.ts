import { GIT_NETWORK_TIMEOUT_MS } from './constants.ts';
import { git } from './exec/exec.ts';
import { requireRepo } from './read.ts';

/** Имена основной ветки, если удалённый не назвал свою (`<remote>/HEAD` не заведён). */
const MAIN_NAMES = ['main', 'master'];

/**
 * От чего отводить новую ветку группы разделения: основная ветка проекта, а не
 * то, что человек выгрузил в папке проекта прямо сейчас. Отвод «от HEAD» уносил
 * в ветку группы, а потом и в её MR, чужие коммиты — стоило человеку оставить
 * основную копию на своей ветке задачи.
 *
 * Порядок: ветка, на которую указывает `<remote>/HEAD`; иначе `<remote>/main`
 * или `<remote>/master`; удалённого нет — локальная `main`/`master`. Ничего из
 * этого нет — `undefined`, и копия отводится от HEAD, как раньше.
 *
 * Удалённую основную ветку сначала подтягиваем (`fetch` её одной): ветка группы
 * начинается со свежей основы, а не со снимка недельной давности. Сеть упала —
 * берём то, что уже есть локально: старая основа лучше чужой ветки.
 */
export async function defaultBaseOf(projectDir: string): Promise<string | undefined> {
  const info = await requireRepo(projectDir);
  const { remote } = info;
  if (remote) {
    const head = await git(projectDir, [
      'symbolic-ref',
      '--quiet',
      '--short',
      `refs/remotes/${remote}/HEAD`,
    ]).catch(() => '');
    const pointed = head.trim().startsWith(`${remote}/`)
      ? head.trim().slice(remote.length + 1)
      : undefined;
    const name =
      pointed && info.remoteBranches.includes(pointed)
        ? pointed
        : MAIN_NAMES.find((candidate) => info.remoteBranches.includes(candidate));
    if (name) {
      await git(projectDir, ['fetch', '--quiet', remote, name], GIT_NETWORK_TIMEOUT_MS).catch(
        () => '',
      );
      return `${remote}/${name}`;
    }
  }
  return MAIN_NAMES.find((candidate) => info.branches.includes(candidate));
}
