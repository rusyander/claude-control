import { describe, it, expect } from 'vitest';
import { languageFor } from './languages';

/**
 * Карта грамматик подсветки.
 *
 * Проверяется не «есть ли ключ в объекте», а что грамматика ДЕЙСТВИТЕЛЬНО
 * загружается: половина записей тянет потоковые режимы по имени экспорта
 * (`dockerFile`, `powerShell`), и опечатка в этом имени не ломает ни сборку, ни
 * типы — файл просто молча открывается без подсветки. Такую поломку ловит
 * только загрузка.
 */
describe('languageFor', () => {
  const cases = [
    'app.ts',
    'app.tsx',
    'main.mjs',
    'index.html',
    'styles.scss',
    'styles.css',
    'package.json',
    'README.md',
    'docker-compose.yml',
    'feed.xml',
    'main.py',
    'lib.rs',
    'main.go',
    'App.java',
    'index.php',
    'main.cpp',
    'schema.sql',
    'Widget.vue',
    'deploy.sh',
    'script.ps1',
    'Cargo.toml',
    'app.ini',
    'change.diff',
    'app.rb',
    'init.lua',
    'stats.r',
    'View.swift',
    'build.gradle',
    'Program.cs',
    'Main.kt',
    'Dockerfile',
    'Makefile',
    '.env',
    '.gitignore',
    '.bashrc',
  ];

  it.each(cases)('%s получает грамматику', async (name) => {
    await expect(languageFor(name)).resolves.toBeDefined();
  });

  it('путь с каталогами разбирается по имени файла, а не по всей строке', async () => {
    await expect(languageFor('apps/web/src/app.ts')).resolves.toBeDefined();
    await expect(languageFor('apps\\web\\src\\app.ts')).resolves.toBeDefined();
  });

  it('регистр расширения значения не имеет', async () => {
    await expect(languageFor('README.MD')).resolves.toBeDefined();
  });

  it('незнакомое расширение — обычный текст, а не отказ', async () => {
    await expect(languageFor('dump.bin')).resolves.toBeUndefined();
    await expect(languageFor('LICENSE')).resolves.toBeUndefined();
  });
});
