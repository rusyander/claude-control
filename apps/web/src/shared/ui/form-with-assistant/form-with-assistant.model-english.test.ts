import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

/**
 * `kind` и `schema` помощника формы уходят модели дословно (`assistant.ts`
 * сервера собирает из них задание) — поэтому по-английски (D-E, решение
 * владельца 27.09.2026). Человек их не видит: ни заголовка, ни подсказки из них
 * окно не рисует. Язык ответа следует за человеком — это решает сервер.
 *
 * Сторож читает КАЖДУЮ форму фич с `FormWithAssistant`: новая форма с русской
 * схемой краснеет здесь, а не на живом прогоне. Описание полей (`spec`) часто
 * собирается в `model/*Assistant*.ts` фичи — там сторож читает каждое `hint`.
 * Подписи вариантов (`label`) — данные человека (имена правил, проектов), их
 * язык не проверяется.
 */
const FEATURES = resolve(import.meta.dirname, '../../../features');
const CYRILLIC = /[А-Яа-яЁё]/;

function formFiles(): string[] {
  const found: string[] = [];
  for (const feature of readdirSync(FEATURES)) {
    const ui = join(FEATURES, feature, 'ui');
    // У фичи без папки ui форм нет — пропускаем её.
    const names = existsSync(ui) ? readdirSync(ui, { recursive: true, encoding: 'utf8' }) : [];
    for (const name of names) {
      if (!name.endsWith('.tsx') || name.includes('.test.')) continue;
      const path = join(ui, name);
      if (readFileSync(path, 'utf8').includes('<FormWithAssistant')) found.push(path);
    }
  }
  return found;
}

/**
 * Описания полей помощника в фичах: `model/<что-то>Assistant<что-то>.ts`, тесты
 * мимо. Хвост после `Assistant` нужен: описания групп вынесены в
 * `groupAssistantSpec.ts`, и строгая маска `*Assistant.ts` молча их теряла.
 */
function specFiles(): string[] {
  const found: string[] = [];
  for (const feature of readdirSync(FEATURES)) {
    const model = join(FEATURES, feature, 'model');
    const names = existsSync(model) ? readdirSync(model) : [];
    for (const name of names) {
      if (/Assistant\w*\.ts$/.test(name) && !/\.test\.ts$/.test(name))
        found.push(join(model, name));
    }
  }
  return found;
}

/** Русское в значении свойства `hint` — это уходит модели дословно. */
export function hintDrift(path: string, text: string): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const drift: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === 'hint') {
      const value = node.initializer.getText(file);
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      if (CYRILLIC.test(value)) drift.push(`${line}:hint: ${value.slice(0, 60)}`);
      if (/\bt\(/.test(value)) drift.push(`${line}:hint через t(): ${value.slice(0, 60)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return drift;
}

/** Русское в `kind`/`schema`/`spec` у `FormWithAssistant` и `kind`, собранный через `t(...)`. */
export function assistantDrift(path: string, text: string): string[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const drift: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(file) === 'FormWithAssistant'
    ) {
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const name = attribute.name.getText(file);
        if (name !== 'kind' && name !== 'schema' && name !== 'spec') continue;
        const value = attribute.initializer?.getText(file) ?? '';
        const line = file.getLineAndCharacterOfPosition(attribute.getStart(file)).line + 1;
        if (CYRILLIC.test(value)) drift.push(`${line}:${name}: ${value.slice(0, 60)}`);
        // Словарь окна переводит `kind` на язык человека — модели уходит русский.
        if (name === 'kind' && /\bt\(/.test(value)) drift.push(`${line}:kind через t(): ${value}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return drift;
}

describe('помощник формы — задание модели по-английски (D-E)', () => {
  it('все формы с помощником найдены', () => {
    expect(formFiles().length).toBeGreaterThanOrEqual(8);
  });

  it('ни в одной форме kind/schema не русские и не из словаря', () => {
    const drift = formFiles().flatMap((path) =>
      assistantDrift(path, readFileSync(path, 'utf8')).map(
        (hit) => `${path.slice(FEATURES.length + 1).replaceAll('\\', '/')}:${hit}`,
      ),
    );
    expect(drift).toEqual([]);
  });

  it('описания полей в model/*Assistant*.ts — по-английски', () => {
    const files = specFiles();
    expect(files.length).toBeGreaterThanOrEqual(8);
    // Каждый файл фичи с полем `hint` в описании помощника попал в обход.
    expect(files.some((path) => path.endsWith('groupAssistantSpec.ts'))).toBe(true);
    const drift = files.flatMap((path) =>
      hintDrift(path, readFileSync(path, 'utf8')).map(
        (hit) => `${path.slice(FEATURES.length + 1).replaceAll('\\', '/')}:${hit}`,
      ),
    );
    expect(drift).toEqual([]);
  });

  it('сторож описаний краснеет на русском hint и на hint из словаря (must-fail)', () => {
    const probe =
      "export const s = { a: { type: 'text', hint: 'Имя' }, b: { type: 'text', hint: t('x') } };";
    expect(hintDrift('probe.ts', probe)).toHaveLength(2);
    expect(hintDrift('probe.ts', probe.replace('Имя', 'Name').replace("t('x')", "'X'"))).toEqual(
      [],
    );
  });

  it('сторож краснеет на русской схеме и на kind из словаря (must-fail)', () => {
    const probe = [
      'export const X = () => (',
      "  <FormWithAssistant kind={t('rules.title')} schema={{ a: 'Название' }} fields={{}}>",
      '    <div />',
      '  </FormWithAssistant>',
      ');',
    ].join('\n');
    expect(assistantDrift('probe.tsx', probe)).toHaveLength(2);
    const clean = probe.replace("{t('rules.title')}", '"rule"').replace('Название', 'Name');
    expect(assistantDrift('probe.tsx', clean)).toEqual([]);
  });
});
