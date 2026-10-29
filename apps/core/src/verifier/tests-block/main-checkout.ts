import type { Fact } from '@agentdeck/contracts/core/facts';
import { basename, dirname } from 'node:path';
import { commonDirSync } from '../../platform/git.ts';

/**
 * Основная папка репозитория задачи (G15): блок тестов живёт в `<main checkout>/.agent/tests/`, а
 * задача работает в копии — общий каталог git `<main>/.git` ведёт к основной. Репозиторий без
 * рабочей папки (bare) — блока тестов нет (`absent`); общий каталог не `.git` (отдельный
 * git-dir) — основную папку не назвать, `unknown`: писать «куда-нибудь» нельзя.
 */
export function mainCheckoutOf(repo: string): Fact<string> {
  const common = commonDirSync(repo);
  if (!('value' in common)) return common;
  const dir = common.value.replace(/[\\/]+$/, '');
  if (basename(dir) === '.git') return { value: dirname(dir) };
  if (dir.endsWith('.git')) return { absent: true };
  return { unknown: `общий каталог git ${dir} — не <main>/.git, основная папка не названа` };
}
