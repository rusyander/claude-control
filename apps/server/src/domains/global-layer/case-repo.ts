import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GlobalLayerText } from '@agentdeck/contracts';

/**
 * Случай корпуса — настоящий git-репозиторий, а не вход функции. Обе стороны
 * пары читают ветку git'ом (развилка с основной, `git grep` по дереву, размеры
 * добавленных файлов), и сравнивать их на подставленных массивах значило бы
 * проверять не то, что работает перед MR.
 *
 * Раскладка: `origin` — основная ветка с базовыми файлами; `work` — клон с
 * веткой `feature`, где лежит изменение случая. У клона есть `origin/HEAD`,
 * поэтому сторона панели находит основную так же, как в настоящей копии.
 */

/** Файлы: путь → текст; `null` в ветке — файл удалён. */
export type CaseFiles = Record<string, string | null>;

export interface CorpusCase {
  id: string;
  title: GlobalLayerText;
  base?: CaseFiles;
  branch: CaseFiles;
  /** Сита → то, что она обязана отметить; пустой список — обязана молчать. */
  expect: Record<string, string[]>;
}

export interface Corpus {
  base: CaseFiles;
  cases: CorpusCase[];
}

/**
 * Секреты в корпусе — подстановки, а не строки: файл корпуса лежит в
 * репозитории панели, и настоящая форма ключа в нём сама остановила бы MR
 * (сита секретов) и пуш (защита хостинга). Значения собираются здесь из
 * частей, ни одна из которых сама по себе на ключ не похожа.
 */
const FILL = 'Q7mZ4kP9tR2wX8vB5nL3hJ6dF1gS0aY';
const SECRETS: Readonly<Record<string, string>> = {
  sk: ['sk', FILL].join('-'),
  'sk-placeholder': ['sk', 'your', 'key', 'here', '1234567890'].join('-'),
  'url-local': ['postgres:/', '/app:secret', '@localhost:5432/app'].join(''),
  'url-remote': ['postgres:/', '/app:Zr8qLw3v', '@db.prod.internal:5432/app'].join(''),
  pem: ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' '),
};

export function expandSecrets(text: string): string {
  return text.replace(/\{\{secret:([\w-]+)\}\}/g, (whole, name: string) => SECRETS[name] ?? whole);
}

/**
 * git без пользовательской конфигурации: глобальный `core.hooksPath`, подпись
 * коммитов или `autocrlf` человека не должны менять ни сборку случая, ни то, что
 * увидят стороны. Окружение отдаётся и прогонам сторон.
 */
export function isolatedGitEnv(root: string): NodeJS.ProcessEnv {
  const empty = join(root, 'gitconfig-empty');
  writeFileSync(empty, '');
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'corpus',
    GIT_AUTHOR_EMAIL: 'corpus@example.com',
    GIT_COMMITTER_NAME: 'corpus',
    GIT_COMMITTER_EMAIL: 'corpus@example.com',
  };
}

function git(cwd: string, env: NodeJS.ProcessEnv, args: string[]): void {
  const result = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${(result.stderr || result.stdout || '').trim()}`);
  }
}

function writeFiles(dir: string, files: CaseFiles): void {
  for (const [path, text] of Object.entries(files)) {
    const target = join(dir, path);
    if (text === null) {
      rmSync(target, { force: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, expandSecrets(text));
  }
}

/** Собрать репозиторий случая; вернуть каталог рабочей копии на ветке `feature`. */
export function buildCaseRepo(
  root: string,
  corpus: Corpus,
  item: CorpusCase,
  env: NodeJS.ProcessEnv,
): string {
  const origin = join(root, item.id, 'origin');
  const work = join(root, item.id, 'work');
  mkdirSync(origin, { recursive: true });
  git(origin, env, ['init', '-q', '-b', 'main']);
  writeFiles(origin, { ...corpus.base, ...item.base });
  git(origin, env, ['add', '-A']);
  git(origin, env, ['commit', '-q', '-m', 'base']);
  git(join(root, item.id), env, ['clone', '-q', 'origin', 'work']);
  git(work, env, ['checkout', '-q', '-b', 'feature']);
  writeFiles(work, item.branch);
  git(work, env, ['add', '-A']);
  git(work, env, ['commit', '-q', '-m', item.id]);
  return work;
}
