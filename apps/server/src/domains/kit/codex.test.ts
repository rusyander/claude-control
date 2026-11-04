import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_SKILL_DESCRIPTION_MAX,
  CodexKitTooLarge,
  codexKitAppend,
  codexSkillIndex,
  codexSkillNames,
  kitComposeRefusal,
} from './codex.ts';

/**
 * Набор панели в Codex — текстом в дописку сеанса ядра (`codexKitAppend`). Набор — временный
 * каталог; сам сеанс с этим текстом проверяет `tools/qa/check-core-chat.mjs`.
 */

let root: string;
let kitDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-codex-kit-'));
  kitDir = join(root, 'kit');
  mkdirSync(join(kitDir, 'rules'), { recursive: true });
  mkdirSync(join(kitDir, 'skills', 'verify-by-running'), { recursive: true });
  writeFileSync(join(kitDir, 'rules', 'standard.md'), '# agentdeck kit rules\n\n- RULE-STANDARD\n');
  writeFileSync(join(kitDir, 'rules', 'local.md'), '- RULE-LOCAL\n');
  writeFileSync(
    join(kitDir, 'skills', 'verify-by-running', 'SKILL.md'),
    '---\nname: verify-by-running\ndescription: "Run the check before calling work done"\n---\nbody\n',
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('codexKitAppend — набор Codex в дописке сеанса ядра', () => {
  const append = (local: boolean, max = 100_000) => codexKitAppend({ kitDir, local, max });

  it('правила набора — первыми, local.md — только варианту локальной модели', () => {
    expect(append(false).startsWith('# agentdeck kit rules')).toBe(true);
    expect(append(false)).toContain('RULE-STANDARD');
    expect(append(false)).not.toContain('RULE-LOCAL');
    expect(append(true)).toContain('RULE-LOCAL');
  });

  it('навыки — списком с описанием, путь один раз в заголовке', () => {
    const text = append(false);
    const skillPath = join(kitDir, 'skills', 'verify-by-running', 'SKILL.md');
    expect(text).toContain(
      `follow it: ${join(kitDir, 'skills', '<name>', 'SKILL.md')} (e.g. ${skillPath}).`,
    );
    expect(text).toContain('\n- verify-by-running — Run the check before calling work done');
    expect(text.split(skillPath)).toHaveLength(2);
  });

  it('длинные описания навыков режутся только в локальном варианте (L4c, F3)', () => {
    const long = 'слово '.repeat(200).trim();
    mkdirSync(join(kitDir, 'skills', 'wordy'), { recursive: true });
    writeFileSync(
      join(kitDir, 'skills', 'wordy', 'SKILL.md'),
      `---\nname: wordy\ndescription: ${long}\n---\nbody\n`,
    );
    expect(append(false)).toContain(long);
    expect(append(true)).not.toContain(long);
    expect(append(true)).toContain('wordy — ');
  });

  it('тесный предел ужимает список навыков до имён, правила целы (W10)', () => {
    for (let i = 0; i < 40; i++) {
      mkdirSync(join(kitDir, 'skills', `skill-${i}`), { recursive: true });
      writeFileSync(
        join(kitDir, 'skills', `skill-${i}`, 'SKILL.md'),
        `---\nname: skill-${i}\ndescription: "${'Use when a long trigger phrase applies. '.repeat(12)}"\n---\nbody\n`,
      );
    }
    const full = append(false);
    const tight = append(false, full.length - 1000);
    expect(tight).toContain('- RULE-STANDARD');
    for (let i = 0; i < 40; i++) expect(tight).toContain(`skill-${i}`);
    expect(tight).not.toContain('Use when a long trigger phrase applies. '.repeat(12));
  });

  it('правила не помещаются — отказ с размером и пределом, а не урезанные правила', () => {
    writeFileSync(join(kitDir, 'rules', 'huge.md'), 'x'.repeat(30_000));
    let thrown: unknown;
    try {
      append(false, 20_000);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CodexKitTooLarge);
    expect((thrown as CodexKitTooLarge).limit).toBe(20_000);
    expect((thrown as CodexKitTooLarge).size).toBeGreaterThan(30_000);
    // Отказ человеку называет оба числа, разбитые по разрядам.
    expect(kitComposeRefusal(thrown)).toContain('20 000');
    expect(kitComposeRefusal(new Error('диск'))).not.toContain('20 000');
  });
});

describe('список навыков в наложении: длинное описание обрезается', () => {
  const line = (description: string, clip = true) =>
    codexSkillIndex([{ name: 'big', description, path: '/k/big/SKILL.md' }], undefined, clip);

  it('описание длиннее предела режется по слову и кончается «…»; путь к SKILL.md остаётся', () => {
    const text = line('слово '.repeat(200));
    const shown = text.split('\n').at(-1) ?? '';
    expect(shown).toMatch(/^- big — .+… \(\/k\/big\/SKILL\.md\)$/);
    const description = shown.slice('- big — '.length, shown.indexOf(' (/k/'));
    expect(description.length).toBeLessThanOrEqual(CODEX_SKILL_DESCRIPTION_MAX);
    expect(description.endsWith('слово…')).toBe(true);
  });

  it('короткое описание — как есть, ровно по пределу — тоже', () => {
    expect(line('Use when X')).toContain('- big — Use when X (/k/big/SKILL.md)');
    const exact = 'я'.repeat(CODEX_SKILL_DESCRIPTION_MAX);
    expect(line(exact)).toContain(`- big — ${exact} (`);
  });

  it('обычный (не локальный) набор и слои групп описаний не режут — как до L4b (L4c, F3)', () => {
    const long = 'слово '.repeat(200).trim();
    expect(line(long, false)).toContain(`- big — ${long} (`);
    expect(
      codexSkillIndex([{ name: 'big', description: long, path: '/k/big/SKILL.md' }]),
    ).toContain(long);
  });
});

describe('список навыков: путь один раз в заголовке только при общем каталоге', () => {
  const dir = join('k', 'skills');
  const at = (name: string) => ({
    name,
    description: `Use when ${name}`,
    path: join(dir, name, 'SKILL.md'),
  });

  it('все навыки в каталоге — строки без пути, в заголовке шаблон и пример; у имён так же', () => {
    const skills = [at('a'), at('b')];
    const index = codexSkillIndex(skills, undefined, false, dir);
    expect(index).toContain(
      `follow it: ${join(dir, '<name>', 'SKILL.md')} (e.g. ${join(dir, 'a', 'SKILL.md')}).`,
    );
    expect(index.split('\n').slice(2)).toEqual(['- a — Use when a', '- b — Use when b']);
    expect(codexSkillNames(skills, undefined, dir).split('\n').slice(2)).toEqual(['- a', '- b']);
  });

  it('навык вне каталога — путь снова в каждой строке, иначе модель откроет не тот файл', () => {
    const elsewhere = join('elsewhere', 'b', 'SKILL.md');
    const skills = [at('a'), { ...at('b'), path: elsewhere }];
    const index = codexSkillIndex(skills, undefined, false, dir);
    expect(index).not.toContain('<name>');
    expect(index).toContain(`- b — Use when b (${elsewhere})`);
    expect(codexSkillNames(skills, undefined, dir)).toContain(
      `- a (${join(dir, 'a', 'SKILL.md')})`,
    );
  });
});
