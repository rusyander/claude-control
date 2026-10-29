import { createHash } from 'node:crypto';
import type { CheckEntry, CheckRegistry, CheckRequest } from '@agentdeck/contracts/core/records';
import { CAPTURE_ENV_NAMES } from '../../platform/capture-shim.ts';
import { expandTemplate } from '../../verifier/run/argv.ts';

/**
 * Какая запись реестра отвечает на запрос (04:50-51). По `checkId` — запись с этим id или `null`
 * (запрошено, но нет: `fail{absent}`, G3). По argv — запись, чей развёрнутый шаблон для единицы
 * совпал с argv; не совпала ни одна — производная запись `captured:<sha8>` (предложение в отчёте,
 * никогда не вопрос — R:S2-17). Производная гонится на всём репозитории (единица `.`), без узкого
 * фильтра и без повторов: что это за раннер, ядро не знает.
 */

export type Match =
  | { kind: 'entry'; entry: CheckEntry; unit: string }
  | { kind: 'derived'; entry: CheckEntry; unit: '.' }
  | { kind: 'absent'; checkId: string };

/** Имя исполняемого без каталога и расширения Windows: `C:\x\npx.cmd` и `npx` — одна команда. */
function bare(word: string): string {
  const base = word.replace(/\\/g, '/').split('/').pop() ?? word;
  return base.replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase();
}

export function normaliseArgv(argv: readonly string[]): string[] {
  const [head, ...rest] = argv;
  return head === undefined ? [] : [bare(head), ...rest];
}

export function derivedId(argv: readonly string[]): string {
  const sha = createHash('sha256')
    .update(JSON.stringify(normaliseArgv(argv)))
    .digest('hex');
  return `captured:${sha.slice(0, 8)}`;
}

/**
 * Имена окружения производной записи (A2-F01): имена прокладки по умолчанию и те, чьи значения
 * вызывающий прислал. С пустым списком прогон с `CI=1` повторял бы запись, снятую без него, —
 * ровно то, что окружение вызывающего в ключе (`caller-env.ts`) должно было закрыть.
 */
function derivedEnvAllow(callerEnv: CheckRequest['callerEnv']): string[] {
  return [...new Set([...CAPTURE_ENV_NAMES, ...Object.keys(callerEnv ?? {})])].sort();
}

function derivedEntry(argv: readonly string[], callerEnv: CheckRequest['callerEnv']): CheckEntry {
  return {
    id: derivedId(argv),
    class: 'build',
    argv: [...argv],
    cwd: '',
    unit: 'project',
    requiredAt: [],
    baseDependent: false,
    inputs: [],
    envAllow: derivedEnvAllow(callerEnv),
    tools: [],
    artifacts: [],
    needs: [],
    source: 'detected',
  };
}

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Единица прогона записи: проверка уровня проекта (`unit: 'project'`, и `file-set`, пока выборки
 * файлов нет) гонится на всей копии — `.`, её ключ — всё дерево. Посчитать её по замыканию одной
 * единицы — значит не заметить правку соседней и повторить чужой зелёный.
 */
export function runUnitOf(entry: CheckEntry, unit: string): string {
  return entry.unit === 'package' ? unit : '.';
}

export function matchRequest(req: CheckRequest, registry: CheckRegistry | null): Match {
  if (req.checkId !== undefined) {
    const entry = registry?.checks.find((c) => c.id === req.checkId);
    return entry
      ? { kind: 'entry', entry, unit: runUnitOf(entry, req.unit) }
      : { kind: 'absent', checkId: req.checkId };
  }
  const argv = req.argv ?? [];
  const want = normaliseArgv(argv);
  for (const entry of registry?.checks ?? []) {
    let units = [req.unit];
    if (entry.unit !== 'package') units = ['.'];
    else if (req.unit === '') units = Object.keys(registry?.units ?? {});
    for (const unit of units) {
      const expanded = expandTemplate(entry.argv, { unit, selection: [], base: null, files: [] });
      if (same(normaliseArgv(expanded), want)) return { kind: 'entry', entry, unit };
    }
  }
  return { kind: 'derived', entry: derivedEntry(argv, req.callerEnv), unit: '.' };
}
