import { relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { DECISION_CLASSES } from '@agentdeck/contracts/core/decisions';
import { coreProgram, PROGRAM_TIMEOUT_MS, SRC } from './__fixtures__/ts-program.ts';

/**
 * P01 (00 §Decision classes, F01): у каждого класса решений ровно один судья — функция в модуле
 * из реестра `core/decisions.ts`. Проверка идёт через проверяющий TypeScript, а не по тексту:
 * выведенный тип результата (с распаковкой Promise) ловит и функцию без объявленного типа.
 * Экспорт формы «решение» вне своего модуля, второй экспорт того же класса или тип `…Decision`
 * вне реестра — красный.
 */

/**
 * Типы с окончанием `Decision`, которые не класс решений: имя совпало, судьи нет. Каждая строка —
 * с причиной; новая строка — осознанное решение, а не обход.
 */
const NOT_DECISION_CLASSES: Record<string, string> = {
  // Итог выбора порта при старте: факт платформы о свободном порте, а не суд над задачей.
  'platform/ports.ts:PortDecision': 'platform fact (port allocation outcome)',
};

interface Judge {
  file: string;
  name: string;
  type: string;
}

/** Программа ядра — общая с каталогом сигналов (`__fixtures__/ts-program.ts`). */
const program = coreProgram;

/** Имя типа результата: алиас или символ, Promise<…> распакован. */
function resultTypeName(checker: ts.TypeChecker, type: ts.Type): string | undefined {
  const symbolName = (t: ts.Type) => t.aliasSymbol?.name ?? t.getSymbol()?.name;
  if (symbolName(type) === 'Promise') {
    const [inner] = checker.getTypeArguments(type as ts.TypeReference);
    return inner ? symbolName(inner) : undefined;
  }
  return symbolName(type);
}

/** Каждый экспорт-функция каждого файла ядра (кроме тестов и стендов) с именем типа результата. */
function exportedJudges(p: ts.Program): Judge[] {
  const checker = p.getTypeChecker();
  const out: Judge[] = [];
  for (const sf of p.getSourceFiles()) {
    const rel = relative(SRC, sf.fileName).replaceAll('\\', '/');
    if (rel.startsWith('..') || rel.endsWith('.test.ts') || rel.includes('__fixtures__')) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) continue;
    for (const exp of checker.getExportsOfModule(moduleSymbol)) {
      const decl = exp.valueDeclaration;
      if (!decl) continue;
      for (const sig of checker.getTypeOfSymbolAtLocation(exp, decl).getCallSignatures()) {
        const type = resultTypeName(checker, sig.getReturnType());
        if (type?.endsWith('Decision')) out.push({ file: rel, name: exp.name, type });
      }
    }
  }
  return out;
}

function ownsFile(module: string, file: string): boolean {
  return file === `${module}.ts` || file.startsWith(`${module}/`);
}

function violations(judges: Judge[]): string[] {
  const byType = new Map<string, (typeof DECISION_CLASSES)[number]>(
    DECISION_CLASSES.map((c) => [c.decisionType, c]),
  );
  const out: string[] = [];
  const seen = new Map<string, Judge[]>();
  for (const j of judges) {
    const cls = byType.get(j.type);
    if (!cls) {
      if (!NOT_DECISION_CLASSES[`${j.file}:${j.type}`])
        out.push(`${j.file}:${j.name} returns ${j.type}, not a registered decision class`);
      continue;
    }
    if (!ownsFile(cls.module, j.file))
      out.push(`${j.file}:${j.name} judges ${cls.id} outside its module ${cls.module}`);
    seen.set(cls.id, [...(seen.get(cls.id) ?? []), j]);
  }
  for (const [id, list] of seen) {
    if (list.length > 1)
      out.push(
        `${id} has ${list.length} judges: ${list.map((j) => `${j.file}:${j.name}`).join(', ')}`,
      );
  }
  return out;
}

describe('decision classes', () => {
  it('P01 the registry is well-formed: unique ids, unique result types, unique owner modules', () => {
    const ids = DECISION_CLASSES.map((c) => c.id);
    const types = DECISION_CLASSES.map((c) => c.decisionType);
    const modules = DECISION_CLASSES.map((c) => c.module);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(types).size).toBe(types.length);
    expect(new Set(modules).size).toBe(modules.length);
    for (const c of DECISION_CLASSES) expect(c.decisionType).toMatch(/^[A-Z]\w*Decision$/);
  });

  it(
    'P01 every decision-shaped export of the core sits in its owning module, one judge per class',
    () => {
      const judges = exportedJudges(program());
      expect(violations(judges)).toEqual([]);
      // Судьи, что уже есть в фазе 2, найдены по типу — проверка видит настоящий код.
      expect(judges.map((j) => `${j.type}@${j.file}`).sort()).toEqual(
        expect.arrayContaining([
          'AuthorityDecision@policy/authority/authority.ts',
          'ReconcileDecision@conductor/reconcile.ts',
          'SignalDecision@observer/judge.ts',
        ]),
      );
      // Каждая строка исключений ещё жива: мёртвое исключение — мусор, который маскирует будущее.
      for (const key of Object.keys(NOT_DECISION_CLASSES)) {
        expect(judges.some((j) => `${j.file}:${j.type}` === key)).toBe(true);
      }
    },
    PROGRAM_TIMEOUT_MS,
  );

  it(
    'P01 goes red on a second judge, a judge in a foreign module and an unregistered decision type (no annotation needed)',
    () => {
      const judges = exportedJudges(
        program({
          'conductor/zz-second-judge.ts': [
            "import { decideAuthority } from '../policy/authority/authority.ts';",
            "export const judgeAgain = () => decideAuthority('launch', { token: 'core', nonce: 'valid', peer: 'clear', signature: 'absent' });",
            'export interface ShadowDecision { ok: boolean }',
            'export async function shadow(): Promise<ShadowDecision> { return { ok: true }; }',
          ].join('\n'),
        }),
      );
      expect(violations(judges).sort()).toEqual(
        [
          'authority has 2 judges: policy/authority/authority.ts:decideAuthority, conductor/zz-second-judge.ts:judgeAgain',
          'conductor/zz-second-judge.ts:judgeAgain judges authority outside its module policy/authority',
          'conductor/zz-second-judge.ts:shadow returns ShadowDecision, not a registered decision class',
        ].sort(),
      );
    },
    PROGRAM_TIMEOUT_MS,
  );
});
