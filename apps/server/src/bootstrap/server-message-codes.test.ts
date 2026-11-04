import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isServerMessageCode, serverMessageCodes } from '@agentdeck/contracts/server-messages';
import { isPanelActionMessageCode } from '@agentdeck/contracts/panel-agent';

/**
 * Код текста, отданный сервером, обязан быть в списке контрактов — иначе панель
 * и телефон его не переведут и молча покажут русскую строку в английском
 * интерфейсе, то есть ровно то, от чего коды заведены.
 *
 * Тело ответа у Fastify не типизировано: `reply.send({ messageCode: 'опечатка' })`
 * tsc пропускает. Поэтому литералы сверяются по тексту исходников. Исходы
 * агента панели несут свои коды (`PANEL_ACTION_MESSAGE_CODES`, словарь окна
 * агента) — они тоже объявлены в контрактах и считаются здесь. Что код
 * переведён на оба языка, проверяют тесты словарей панели и телефона.
 */
const SRC = resolve(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('коды текстов сервера', () => {
  it('каждый `messageCode` в ответах сервера объявлен в contracts/server-messages', () => {
    const unknown: string[] = [];
    let seen = 0;
    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/messageCode:\s*'([^']+)'/g)) {
        seen += 1;
        if (!isServerMessageCode(match[1]) && !isPanelActionMessageCode(match[1]))
          unknown.push(`${relative(SRC, file)}: ${match[1]}`);
      }
    }
    expect(seen).toBeGreaterThan(5);
    expect(unknown).toEqual([]);
  });

  it('каждый объявленный код называет живой код — осиротевший уходит из контрактов и словарей', () => {
    expect(orphanCodes(serverMessageCodes)).toEqual([...LEGACY_TEST_ONLY].sort());
  });

  it('сторож сирот видит код, который никто не называет (must-fail)', () => {
    expect(orphanCodes([...serverMessageCodes, 'g12-never-emitted-probe'])).toContain(
      'g12-never-emitted-probe',
    );
  });
});

/**
 * Коды, которые называют только тесты снимаемых экранов отложенных вопросов и стадий детей
 * (уборка G14, этап 10): уходят вместе с этими тестами. Новый код сюда не добавляется —
 * у осиротевшего кода нет причины жить в словарях.
 */
const LEGACY_TEST_ONLY = [
  'panel-agent-provider-unsupported',
  'panel-agent-cli-exit',
  'split-triage-interrupted-hold',
  'split-triage-interrupted-notice',
  'split-limit-wait-notice',
  'split-group-run-not-started',
  'delivery-human-merge',
  'delivery-human-destructive',
  'delivery-human-credentials',
];

const REPO = resolve(SRC, '../../..');
/** Где код может быть назван: всё живое, кроме самих словарей, шаблонов и тестов. */
const LIVE_ROOTS = [
  'apps/server/src',
  'apps/core/src',
  'apps/web/src',
  'apps/mobile/src',
  'apps/mobile/app',
  'packages',
  'tools',
];
const DICTIONARY =
  /server-texts[\\/]templates\.ts$|i18n[\\/]server-messages[\\/]|contracts[\\/]src[\\/]server-messages[\\/]|\.test\.|__fixtures__/;

function liveFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    if (['node_modules', 'dist', 'android', '.expo'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return liveFiles(path);
    return /\.(m?js|cjs|tsx?|json)$/.test(entry.name) && !DICTIONARY.test(path) ? [path] : [];
  });
}

let liveText: string | undefined;
/**
 * Коды, которых не называет ни один живой файл. Осторожно в сторону «жив»: упоминание где угодно
 * (сервер, ядро, веб, телефон, инструменты) держит код, а живой префикс шаблона (`foo-${x}`) держит
 * все коды под ним — сирота здесь точно сирота.
 */
function orphanCodes(codes: readonly string[]): string[] {
  liveText ??= LIVE_ROOTS.flatMap((root) => liveFiles(join(REPO, root)))
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  const text = liveText;
  const prefixes = [...new Set([...text.matchAll(/[`'"]([a-z0-9-]+-)\$\{/g)].map((m) => m[1]!))];
  return codes
    .filter(
      (code) =>
        !text.includes(`'${code}'`) &&
        !text.includes(`"${code}"`) &&
        !text.includes(`\`${code}\``) &&
        !prefixes.some((prefix) => code.startsWith(prefix)),
    )
    .sort();
}
