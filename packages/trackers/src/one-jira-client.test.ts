import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Один клиент Jira на дерево (этап 12, D15, I1): адрес Jira REST собирает только
 * `packages/trackers`. Второй сборщик — второй клиент: панель и входящие ядра снова разошлись бы в
 * диалекте, авторизации и кодировании JQL. Заглушки (`packages/stub-tracker`, `tools/`) — сторона
 * трекера, а не клиент; тесты и фикстуры пишут адреса заглушки нарочно.
 */

const ROOT = resolve(import.meta.dirname, '../../..');

/** Признаки сборщика Jira REST в коде клиента. */
const COMPOSER = [
  /\/rest\/api\/\$\{/, // корень диалекта из переменной
  /\/rest\/api\/[23]\//, // путь Jira с зашитой версией
  /search\/jql\?/, // облачный поиск
  /[`'"?&]jql=/, // строка запроса поиска
  /function\s+jiraApi\b/, // свой корень Jira
];

const OWNERS = /^packages\/(trackers|stub-tracker)\//;
const SKIP = /\.test\.|__fixtures__|\.d\.m?ts$/;

function clientSources(): string[] {
  const out = execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ':(glob)apps/*/src/**',
      ':(glob)packages/*/src/**',
    ],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  // `--cached` называет и удалённые в рабочей копии файлы: их кода уже нет, читать нечего.
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (path) =>
        /\.(ts|tsx|mts|mjs|js)$/.test(path) &&
        !OWNERS.test(path) &&
        !SKIP.test(path) &&
        existsSync(join(ROOT, path)),
    );
}

function composerLines(path: string, text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, index) =>
      COMPOSER.some((pattern) => pattern.test(line))
        ? [`${path}:${index + 1}: ${line.trim()}`]
        : [],
    );
}

describe('trackers/one-jira-client', () => {
  it('признаки ловят прежний сборщик панели (проверка не может быть всегда зелёной)', () => {
    const old = [
      'export function jiraApi(access) {',
      '  return `${access.baseUrl}/rest/api/${access.deployment === "cloud" ? "3" : "2"}`;',
      '  const query = `jql=${encodeURIComponent(jql)}&maxResults=${limit}`;',
      '      ? [`${api}/search/jql?${query}`, `${api}/search?${query}`]',
      "  fetch('https://tracker.example.com/rest/api/2/issue/PROJ-1');",
    ].join('\n');
    expect(composerLines('planted.ts', old)).toHaveLength(5);
    expect(composerLines('ok.ts', 'const url = `${root}/rest/api/content`; // Confluence')).toEqual(
      [],
    );
  });

  it('адрес Jira REST собирается только в packages/trackers', () => {
    const files = clientSources();
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((path) =>
      composerLines(path, readFileSync(join(ROOT, path), 'utf8')),
    );
    expect(found).toEqual([]);
  });
});
