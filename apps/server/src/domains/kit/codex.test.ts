import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_COMPACT_LIMIT_ENV,
  CODEX_KIT_ARG_LIMIT,
  CODEX_KIT_ENV,
  CODEX_MCP_OFF_ENV,
  CODEX_SKILL_DESCRIPTION_MAX,
  CODEX_TOOL_OUTPUT_LIMIT_ENV,
  CodexKitTooLarge,
  buildCodexOverlay,
  codexSkillIndex,
  withCodexKit,
  writeCodexOverlay,
} from './codex.ts';

/**
 * Набор панели в Codex — наложение на запуск. Набор и дом Codex — временные
 * каталоги; `config.toml` человека только читается. Что из этого реально
 * принимает настоящий codex, проверяет `tools/qa/check-codex-kit.mjs`.
 */

let root: string;
let kitDir: string;
let codexHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-codex-kit-'));
  kitDir = join(root, 'kit');
  codexHome = join(root, 'codex-home');
  mkdirSync(join(kitDir, 'rules'), { recursive: true });
  mkdirSync(join(kitDir, 'skills', 'verify-by-running'), { recursive: true });
  mkdirSync(codexHome, { recursive: true });
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

describe('buildCodexOverlay', () => {
  it('собственные инструкции человека — первыми, правила набора — после', () => {
    writeFileSync(
      join(codexHome, 'config.toml'),
      'developer_instructions = "USER-OWN"\nmodel = "x"\n',
    );
    const overlay = buildCodexOverlay({ kitDir, local: false, codexHome });
    expect(overlay.appServer.indexOf('USER-OWN')).toBe(0);
    expect(overlay.appServer).toContain('RULE-STANDARD');
    expect(overlay.appServer.indexOf('RULE-STANDARD')).toBeGreaterThan(
      overlay.appServer.indexOf('USER-OWN'),
    );
  });

  it('local.md — только варианту локальной модели', () => {
    expect(buildCodexOverlay({ kitDir, local: false, codexHome }).exec).not.toContain('RULE-LOCAL');
    expect(buildCodexOverlay({ kitDir, local: true, codexHome }).exec).toContain('RULE-LOCAL');
  });

  it('навыки: у exec — список с описанием и путём, у app-server — только каталог', () => {
    const overlay = buildCodexOverlay({ kitDir, local: false, codexHome });
    const skillPath = join(kitDir, 'skills', 'verify-by-running', 'SKILL.md');
    expect(overlay.exec).toContain(
      `- verify-by-running — Run the check before calling work done (${skillPath})`,
    );
    expect(overlay.appServer).not.toContain('verify-by-running');
    expect(overlay.skillsDir).toBe(join(kitDir, 'skills'));
  });

  it('длинные описания навыков режутся только в локальном наложении (L4c, F3)', () => {
    const long = 'слово '.repeat(200).trim();
    mkdirSync(join(kitDir, 'skills', 'wordy'), { recursive: true });
    writeFileSync(
      join(kitDir, 'skills', 'wordy', 'SKILL.md'),
      `---
name: wordy
description: ${long}
---
body
`,
    );
    expect(buildCodexOverlay({ kitDir, local: false, codexHome }).exec).toContain(long);
    const local = buildCodexOverlay({ kitDir, local: true, codexHome }).exec;
    expect(local).not.toContain(long);
    expect(local).toContain('wordy — ');
  });

  it('нечитаемый config.toml человека не роняет сборку: дописывать не к чему', () => {
    writeFileSync(join(codexHome, 'config.toml'), 'developer_instructions = [broken');
    expect(buildCodexOverlay({ kitDir, local: false, codexHome }).appServer).toMatch(
      /^# agentdeck kit rules/,
    );
  });

  it('длинный свой текст человека ужимает список навыков, а не отказывает (W10)', () => {
    for (let i = 0; i < 40; i++) {
      mkdirSync(join(kitDir, 'skills', `skill-${i}`), { recursive: true });
      writeFileSync(
        join(kitDir, 'skills', `skill-${i}`, 'SKILL.md'),
        `---\nname: skill-${i}\ndescription: "${'Use when a long trigger phrase applies. '.repeat(12)}"\n---\nbody\n`,
      );
    }
    const full = buildCodexOverlay({ kitDir, local: false, codexHome }).exec;
    // Свой текст такой длины, что полный список уже не помещается рядом с ним.
    const own = 'O'.repeat(CODEX_KIT_ARG_LIMIT - full.length + 2000);
    writeFileSync(join(codexHome, 'config.toml'), `developer_instructions = "${own}"\n`);

    const exec = buildCodexOverlay({ kitDir, local: false, codexHome }).exec;
    expect(exec.startsWith(own)).toBe(true);
    expect(exec).toContain('- RULE-STANDARD');
    for (let i = 0; i < 40; i++) expect(exec).toContain(`- skill-${i} `);
    expect(exec).not.toContain('Use when a long trigger phrase applies. '.repeat(12));
  });

  it('не помещается в командную строку — отказ, а не урезанные правила', () => {
    writeFileSync(join(kitDir, 'rules', 'huge.md'), 'x'.repeat(CODEX_KIT_ARG_LIMIT));
    expect(() => buildCodexOverlay({ kitDir, local: false, codexHome })).toThrow(CodexKitTooLarge);
  });
});

describe('withCodexKit', () => {
  const overlayFile = () =>
    writeCodexOverlay(
      join(root, 'overlay.json'),
      buildCodexOverlay({ kitDir, local: false, codexHome }),
    );

  it('без переменной наложения запуск не меняется', () => {
    const env = { OPENAI_BASE_URL: 'http://x' };
    expect(withCodexKit(['exec', 'привет'], env, 'exec')).toEqual({
      args: ['exec', 'привет'],
      env,
      skillRoots: [],
    });
  });

  it('exec: ключ сразу после подкоманды, до промпта; переменная убрана из окружения', () => {
    const result = withCodexKit(
      ['exec', '-m', 'gpt-5', 'привет'],
      { [CODEX_KIT_ENV]: overlayFile(), OPENAI_BASE_URL: 'http://x' },
      'exec',
    );
    expect(result.args.slice(0, 2)).toEqual(['exec', '-c']);
    expect(result.args.slice(3)).toEqual(['-m', 'gpt-5', 'привет']);
    const value = result.args[2] ?? '';
    expect(value.startsWith('developer_instructions="')).toBe(true);
    // Строка TOML без настоящих переводов строки: cmd-обёртка её не обрежет.
    expect(value).not.toMatch(/\n/);
    expect(JSON.parse(value.slice('developer_instructions='.length))).toContain('RULE-STANDARD');
    expect(result.env).toEqual({ OPENAI_BASE_URL: 'http://x' });
    expect(result.skillRoots).toEqual([]);
  });

  it('app-server: инструкции без списка навыков и корень навыков', () => {
    const result = withCodexKit(['app-server'], { [CODEX_KIT_ENV]: overlayFile() }, 'appServer');
    expect(result.args[0]).toBe('app-server');
    expect(result.args[2]).not.toContain('verify-by-running');
    expect(result.skillRoots).toEqual([join(kitDir, 'skills')]);
    expect(result.env).toEqual({});
  });

  it('файл наложения пропал — missing, а не тихий запуск без набора', () => {
    const result = withCodexKit(
      ['exec', 'привет'],
      { [CODEX_KIT_ENV]: join(root, 'gone.json') },
      'exec',
    );
    expect(result.missing).toBe(true);
  });

  it('выключенные серверы группы: ключ на каждый сразу за подкомандой, имя с точкой — в кавычках', () => {
    const result = withCodexKit(
      ['exec', '-m', 'gpt-5', 'привет'],
      {
        [CODEX_MCP_OFF_ENV]: JSON.stringify(['telegram-inbox', 'figma.dev']),
        OPENAI_BASE_URL: 'x',
      },
      'exec',
    );
    expect(result.args).toEqual([
      'exec',
      '-c',
      'mcp_servers.telegram-inbox.enabled=false',
      '-c',
      'mcp_servers."figma.dev".enabled=false',
      '-m',
      'gpt-5',
      'привет',
    ]);
    expect(result.env).toEqual({ OPENAI_BASE_URL: 'x' });
  });

  it('выключатели и набор вместе: оба ключа за подкомандой, набор не потерян', () => {
    const result = withCodexKit(
      ['exec', 'привет'],
      { [CODEX_KIT_ENV]: overlayFile(), [CODEX_MCP_OFF_ENV]: '["inbox"]' },
      'exec',
    );
    expect(result.args.slice(0, 3)).toEqual(['exec', '-c', 'mcp_servers.inbox.enabled=false']);
    expect(result.args[3]).toBe('-c');
    expect(result.args[4]?.startsWith('developer_instructions="')).toBe(true);
    expect(result.args.at(-1)).toBe('привет');
    expect(result.env).toEqual({});
  });

  it('битый список выключателей — запуск как был, переменная всё равно убрана', () => {
    for (const raw of ['не json', '{"inbox":true}', '[1, ""]']) {
      const result = withCodexKit(['exec', 'привет'], { [CODEX_MCP_OFF_ENV]: raw }, 'exec');
      expect(result.args).toEqual(['exec', 'привет']);
      expect(result.env).toEqual({});
    }
  });

  it('набор пропал — missing без выключателей: вызывающий откажет целиком', () => {
    const result = withCodexKit(
      ['exec', 'привет'],
      { [CODEX_KIT_ENV]: join(root, 'gone.json'), [CODEX_MCP_OFF_ENV]: '["inbox"]' },
      'exec',
    );
    expect(result.missing).toBe(true);
    expect(result.args).toEqual(['exec', 'привет']);
  });

  it('порог сжатия группы (6.2): ключ сразу за подкомандой, после выключателей; переменная убрана', () => {
    const result = withCodexKit(
      ['app-server'],
      { [CODEX_MCP_OFF_ENV]: '["inbox"]', [CODEX_COMPACT_LIMIT_ENV]: '160000', X: '1' },
      'appServer',
    );
    expect(result.args).toEqual([
      'app-server',
      '-c',
      'mcp_servers.inbox.enabled=false',
      '-c',
      'model_auto_compact_token_limit=160000',
    ]);
    expect(result.env).toEqual({ X: '1' });
  });

  it('порог сжатия не целое положительное — ключа нет, переменная убрана', () => {
    for (const raw of ['', '0', '160k', '-5', '1e5', '12.5']) {
      const result = withCodexKit(['exec', '-'], { [CODEX_COMPACT_LIMIT_ENV]: raw }, 'exec');
      expect(result.args).toEqual(['exec', '-']);
      expect(result.env).toEqual({});
    }
  });

  it('tool_output_token_limit arg only for positive int', () => {
    const run = (raw: string) =>
      withCodexKit(['app-server'], { [CODEX_TOOL_OUTPUT_LIMIT_ENV]: raw }, 'appServer');
    expect(run('10000').args).toEqual(['app-server', '-c', 'tool_output_token_limit=10000']);
    for (const raw of ['', '0', '10k', '-5', '1e4', '12.5', ' 100', '0100']) {
      expect(run(raw).args, raw).toEqual(['app-server']);
    }
    // Рядом с порогом сжатия и выключателями MCP — в том же блоке группы, после них.
    const both = withCodexKit(
      ['exec', '-'],
      {
        [CODEX_MCP_OFF_ENV]: '["inbox"]',
        [CODEX_COMPACT_LIMIT_ENV]: '160000',
        [CODEX_TOOL_OUTPUT_LIMIT_ENV]: '2500',
      },
      'exec',
    );
    expect(both.args).toEqual([
      'exec',
      '-c',
      'mcp_servers.inbox.enabled=false',
      '-c',
      'model_auto_compact_token_limit=160000',
      '-c',
      'tool_output_token_limit=2500',
      '-',
    ]);
  });

  it('env var never reaches the child', () => {
    for (const raw of ['10000', 'мусор', '']) {
      const result = withCodexKit(
        ['exec', '-'],
        { [CODEX_TOOL_OUTPUT_LIMIT_ENV]: raw, KEEP: '1' },
        'exec',
      );
      expect(result.env).toEqual({ KEEP: '1' });
      expect(JSON.stringify(result)).not.toContain(CODEX_TOOL_OUTPUT_LIMIT_ENV);
    }
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
