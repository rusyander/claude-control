import { execFile } from 'node:child_process';
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
type CaseFiles = Record<string, string | null>;

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

function expandSecrets(text: string): string {
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

/*
 * git — асинхронно. Сверка запускается наблюдателем за конфигурацией на любую
 * правку `~/.claude`, и при spawnSync сборка корпуса (восемь вызовов git на
 * случай) держала поток сервера 8–12 секунд: все запросы панели вставали, а
 * страница, открытая в эту минуту, рисовалась на языке по умолчанию, пока не
 * дойдёт ответ /api/settings.
 */
function git(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.autocrlf=false', ...args],
      { cwd, env, encoding: 'utf8', windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) {
          resolve();
          return;
        }
        reject(new Error(`git ${args.join(' ')}: ${(stderr || stdout || error.message).trim()}`));
      },
    );
  });
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
export async function buildCaseRepo(
  root: string,
  corpus: Corpus,
  item: CorpusCase,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const origin = join(root, item.id, 'origin');
  const work = join(root, item.id, 'work');
  mkdirSync(origin, { recursive: true });
  await git(origin, env, ['init', '-q', '-b', 'main']);
  writeFiles(origin, { ...corpus.base, ...item.base });
  await git(origin, env, ['add', '-A']);
  await git(origin, env, ['commit', '-q', '-m', 'base']);
  await git(join(root, item.id), env, ['clone', '-q', 'origin', 'work']);
  await git(work, env, ['checkout', '-q', '-b', 'feature']);
  writeFiles(work, item.branch);
  await git(work, env, ['add', '-A']);
  await git(work, env, ['commit', '-q', '-m', item.id]);
  return work;
}
