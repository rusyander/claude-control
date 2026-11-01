import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';

/**
 * Хранилище блока тестов проекта (`.agent/tests/<группа>.tests.json`) глазами ядра: только связь
 * «кейс ↔ файлы кода» (`codePaths`), из которой итог считает покрытие изменённых файлов (G18).
 * Читается в ИСХОДНОМ репозитории: копия его не несёт — `.agent/` исключён из git.
 */

export const TESTS_DIR = join('.agent', 'tests');
const GROUP_SUFFIX = '.tests.json';

export interface CaseCodePaths {
  groupId: string;
  caseId: string;
  codePaths: string[];
}

interface RawCase {
  id?: unknown;
  archived?: unknown;
  codePaths?: unknown;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];

/**
 * Кейсы проекта с их `codePaths`; архивные не в счёт. Каталога нет — `absent` (у проекта нет блока
 * тестов); файл группы не читается или не JSON — `unknown` с его именем: покрытие, посчитанное по
 * части групп, говорило бы «не покрыто» там, где кейс есть.
 */
export function readCaseCodePaths(projectRoot: string): Fact<CaseCodePaths[]> {
  const dir = join(projectRoot, TESTS_DIR);
  // «Нет каталога» — до чтения: ошибка самого чтения — `unknown`, а не «блока нет».
  if (!existsSync(dir)) return { absent: true };
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(GROUP_SUFFIX));
  } catch (err) {
    return { unknown: `${TESTS_DIR}: ${(err as Error).message}` };
  }
  const out: CaseCodePaths[] = [];
  for (const name of names.sort()) {
    let cases: unknown;
    try {
      cases = (JSON.parse(readFileSync(join(dir, name), 'utf8')) as { cases?: unknown }).cases;
    } catch (err) {
      return { unknown: `${name}: ${(err as Error).message}` };
    }
    if (!Array.isArray(cases)) return { unknown: `${name}: no cases list` };
    const groupId = name.slice(0, -GROUP_SUFFIX.length);
    for (const raw of cases as RawCase[]) {
      if (raw === null || typeof raw !== 'object' || raw.archived === true) continue;
      if (typeof raw.id !== 'string') continue;
      out.push({ groupId, caseId: raw.id, codePaths: strings(raw.codePaths) });
    }
  }
  return { value: out };
}
