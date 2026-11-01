import type { Fact } from '@agentdeck/contracts/core/facts';
import { ABSENT, readClass, readFact } from '../../lib/facts/read-fact.ts';
import type { GitOptions } from './git.types.ts';
import { git } from './run.ts';

const LS_REMOTE_LINE = /^([0-9a-f]{40,64})\s+(\S+)$/;

/**
 * `<sha>\t<ref>` построчно → ссылка → коммит. Строка не той формы — исключение, а не пропуск:
 * мусор вместо листинга, молча отброшенный, читался бы как «ветки нет» (P44).
 */
export function parseLsRemote(stdout: string): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const m = LS_REMOTE_LINE.exec(line);
    if (!m) throw new Error(`ls-remote: unexpected line «${line.slice(0, 120)}»`);
    refs[m[2]!] = m[1]!;
  }
  return refs;
}

/**
 * Ссылки удалённого как их видит сервер (класс `git.ls-remote`): конец шага сравнивает их с
 * пушами публикатора, читатель outbox доказывает ими пуш и удаление ветки. Названные ссылки, не
 * найденные сервером, — `absent` (прочитал — нет); любой сбой сети или git — `unknown`, никогда
 * «нет»: «не смог прочитать» и «ветки нет» ведут к разным решениям (P44).
 */
export function lsRemote(
  repo: string,
  remoteOrUrl: string,
  refs: readonly string[] = [],
  options: GitOptions = {},
): Promise<Fact<Record<string, string>>> {
  const { timeoutMs } = readClass('git.ls-remote');
  return readFact('git.ls-remote', async () => {
    const out = await git(repo, ['ls-remote', '--', remoteOrUrl, ...refs], {
      ...options,
      timeoutMs,
    });
    const listed = parseLsRemote(out.stdout);
    if (refs.length > 0 && Object.keys(listed).length === 0) return ABSENT;
    return listed;
  });
}
