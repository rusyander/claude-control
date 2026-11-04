import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { isServerMessageCode } from '@agentdeck/contracts/server-messages';
import { serverMessagesEn } from '../../../../web/src/shared/config/i18n/server-messages/en.ts';
import { serverMessagesRu } from '../../../../web/src/shared/config/i18n/server-messages/ru.ts';
import {
  describeScript,
  describeScriptCoded,
  readScriptDescriptionCoded,
} from './script-description.ts';

/**
 * Один разбор описания для страниц «Скрипты» и «Хуки». Каждый случай ниже —
 * реальное расхождение двух прежних разборов или форма шапки, которую один из
 * них не понимал.
 */
describe('describeScript — описание из шапки файла', () => {
  it('пропускает shebang и склеивает строки //', () => {
    expect(describeScript('#!/usr/bin/env node\n// Первая.\n// Вторая.\n\ncode();\n')).toBe(
      'Первая. Вторая.',
    );
  });

  it('блочный комментарий JS — без хвоста « /» от закрывающей строки', () => {
    const text =
      '#!/usr/bin/env node\n/**\n * Описание модуля.\n * Вторая строка.\n */\nimport x;\n';
    expect(describeScript(text)).toBe('Описание модуля. Вторая строка.');
  });

  it('однострочный блок и «//» после него не смешиваются', () => {
    expect(describeScript('/** Кратко. */\nconst a = 1;\n// не описание\n')).toBe('Кратко.');
  });

  it('PowerShell: блок <# … #> и строки #', () => {
    expect(describeScript('<#\nЧто делает скрипт.\n#>\nWrite-Host ok\n')).toBe(
      'Что делает скрипт.',
    );
    expect(describeScript('# Строка один.\n# Строка два.\n$x = 1\n')).toBe(
      'Строка один. Строка два.',
    );
  });

  it('служебная строка панели «Событие: …» описанием не считается', () => {
    expect(
      describeScript('// Событие: PreToolUse — создано AgentDeck\n// Настоящее описание.\n'),
    ).toBe('Настоящее описание.');
  });

  it('файл без комментариев в шапке — undefined, а не пустая строка', () => {
    expect(describeScript('import x from "y";\nexport {};\n')).toBeUndefined();
    expect(describeScript('')).toBeUndefined();
  });
});

describe('описание хука под английским интерфейсом', () => {
  it('указание eslint `/* global … */` после шапки в описание не попадает', () => {
    const text =
      '#!/usr/bin/env node\n// Хук телефона.\n/* global process, fetch */\nimport x from "y";\n';
    expect(describeScript(text)).toBe('Хук телефона.');
    // Фраза, которая лишь начинается со слова global, — текст, а не указание.
    expect(describeScript('// global hook for every session\n')).toBe(
      'global hook for every session',
    );
  });

  it('строка `@description-code` даёт код и в текст не входит', () => {
    expect(describeScriptCoded('// @description-code hook-description-tests\n// Текст.\n')).toEqual(
      {
        description: 'Текст.',
        descriptionCode: 'hook-description-tests',
      },
    );
    expect(describeScriptCoded('/** @description-code x-y\n * Текст.\n */\n')).toEqual({
      description: 'Текст.',
      descriptionCode: 'x-y',
    });
  });

  /**
   * Скрипты, которые пишет сама панель, показываются на «Хуках» под командой. Их
   * шапка русская (её читает человек в файле), и без кода en-страница показывала
   * её по-русски. Читается настоящий файл: правка шапки без словаря — красная.
   */
  it.each([
    ['хук телефона', '../../domains/chat/outside-relay/outside-relay-hook.mjs'],
    ['хук блока «Тесты»', '../../../../../tools/tests-hook.mjs'],
  ])('%s: код известен, ru по коду = шапке, en без кириллицы', (_name, relative) => {
    const file = fileURLToPath(new URL(relative, import.meta.url));
    const { description, descriptionCode } = readScriptDescriptionCoded(file);
    expect(description).toBeTruthy();
    expect(isServerMessageCode(descriptionCode)).toBe(true);
    const code = descriptionCode as keyof typeof serverMessagesEn;
    expect(serverMessagesRu[code]).toBe(description);
    expect(serverMessagesEn[code]).not.toMatch(/[А-Яа-яЁё]/);
  });
});
