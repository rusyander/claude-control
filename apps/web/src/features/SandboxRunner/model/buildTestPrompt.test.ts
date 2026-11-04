import { beforeAll, describe, expect, it } from 'vitest';
import { i18n } from '@shared/config/i18n';
import type { SandboxKind } from '@entities/Sandbox';
import { buildTestPrompts, type TestContext } from './buildTestPrompt';

/**
 * Готовые запросы песочницы — на языке интерфейса: подписи чипов и текст запроса идут из словаря
 * `sandboxPrompts`, а не зашиты по-русски (английский интерфейс показывал русские чипы).
 */

const textOf = (lang: string) => {
  const t = i18n.getFixedT(lang);
  return (key: string, params?: Record<string, string>): string =>
    t(`sandboxPrompts.${key}`, params);
};

const CASES: Array<[SandboxKind, TestContext]> = [
  ['skill', { title: 'review', description: 'Use when the user asks for a code review of a diff' }],
  ['skill', { title: 'review' }],
  ['rule', { title: 'Коммиты только по просьбе', body: 'Никаких commit и push' }],
  ['rule', { title: 'Язык общения', body: 'Отвечать по-русски' }],
  ['rule', { title: 'Что-то своё' }],
  ['hook', { title: 'guard', event: 'PreToolUse', matcher: 'Write|Edit' }],
  ['hook', { title: 'guard', event: 'PreToolUse', matcher: 'Bash' }],
  ['hook', { title: 'guard', event: 'UserPromptSubmit' }],
  ['script', { title: 'brief', event: 'SessionStart' }],
  ['mcp', { title: 'files', toolName: 'read_file' }],
  ['mcp', { title: 'files' }],
  ['group', { title: 'frontend' }],
];

const all = (lang: string) =>
  CASES.flatMap(([kind, context]) => buildTestPrompts(kind, context, textOf(lang)));

describe('готовые запросы песочницы', () => {
  // Английский словарь — ленивый чанк: без загрузки getFixedT('en') молча отдаёт русский.
  beforeAll(async () => {
    await i18n.loadLanguages('en');
  });

  it.each(['ru', 'en'])(
    '%s: у каждого чипа есть подпись и запрос, ключ словаря не протекает',
    (lang) => {
      for (const chip of all(lang)) {
        expect(chip.label).not.toMatch(/^(skill|rule|hook|mcp|group)\./);
        expect(chip.prompt).not.toMatch(/^(skill|rule|hook|mcp|group)\./);
        expect(chip.prompt).not.toContain('{{');
        expect(chip.label.length).toBeGreaterThan(0);
      }
    },
  );

  it('en: подписи и запросы по-английски; кириллица только в провокации правила о языке', () => {
    const cyrillic = /[А-Яа-яЁё]/;
    for (const chip of all('en')) expect(chip.label, chip.label).not.toMatch(cyrillic);
    const russianPrompts = all('en').filter((chip) => cyrillic.test(chip.prompt));
    // Название правила и группы подставляется как есть, а провокация правила о языке — на другом языке.
    for (const chip of russianPrompts) {
      expect(
        chip.prompt.includes('Кратко, одним предложением') ||
          /«[^»]*[А-Яа-яЁё][^»]*»/.test(chip.prompt),
        chip.prompt,
      ).toBe(true);
    }
  });

  it('ru: подписи прежние, параметры подставлены', () => {
    const [skill] = buildTestPrompts('skill', CASES[0]![1], textOf('ru'));
    expect(skill?.label).toBe('Проверить срабатывание');
    expect(skill?.prompt).toContain('Задача: the user asks for a code review of a diff');
    const mcp = buildTestPrompts('mcp', { title: 'files', toolName: 'read_file' }, textOf('ru'));
    expect(mcp.map((chip) => chip.label)).toEqual(['Список инструментов', 'Вызвать read_file']);
    const hook = buildTestPrompts('hook', CASES[5]![1], textOf('en'));
    expect(hook[0]?.prompt).toMatch(/export const token = "glpat-[A-Za-z0-9]{20}";/);
  });

  it('провокация выбирается по тексту правила: git — коммит, язык — вопрос на другом языке', () => {
    const [git] = buildTestPrompts('rule', CASES[2]![1], textOf('en'));
    expect(git?.prompt).toContain('Commit the current changes');
    const [ru] = buildTestPrompts('rule', CASES[3]![1], textOf('ru'));
    expect(ru?.prompt).toContain('Briefly explain in one sentence');
    const [other] = buildTestPrompts('rule', CASES[4]![1], textOf('en'));
    expect(other?.prompt).toContain('«Что-то своё»');
  });
});
