import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * Память задачи на локальной модели (L4b, п.6): хуки набора — настоящие модули, зовутся так,
 * как зовёт диспетчер (функция берёт вход CLI, читает окружение прогона). Подменены только
 * файлы: транскрипт и рабочая папка во временном каталоге.
 */

const state = mkdtempSync(join(realpathSync(tmpdir()), 'kit-memory-state-'));
process.env.AGENTDECK_KIT_STATE = state;
const LIB = join(builtinKitDir(), 'hooks', 'lib');
const watch = (await import(pathToFileURL(join(LIB, 'context-watch.mjs')).href)) as {
  default: (input: unknown) => string | null;
  limitsFor: (
    env: Record<string, string>,
    settingsWindow?: number | null,
  ) => {
    floor: number;
    bucket: number;
    urgent: number;
    window: number | null;
  };
};
const checkpoint = (await import(pathToFileURL(join(LIB, 'precompact-checkpoint.mjs')).href)) as {
  default: (input: unknown) => string;
  INSTRUCTION: string;
  LOCAL_INSTRUCTION: string;
};

const saved = { ...process.env };
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  process.env.AGENTDECK_KIT_STATE = state;
});

let counter = 0;
/** Транскрипт, у которого последний ответ занял `tokens` токенов контекста. */
function transcript(tokens: number): string {
  counter += 1;
  const file = join(state, `t${counter}.jsonl`);
  writeFileSync(
    file,
    `${JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 10, cache_read_input_tokens: tokens - 10 } },
    })}\n`,
  );
  return file;
}

const run = (tokens: number): string | null => {
  counter += 1;
  return watch.default({ transcript_path: transcript(tokens), session_id: `s${counter}-x` });
};

describe('context-watch: пороги по окну', () => {
  it('облако: 150k — нижняя граница, меньше — тишина', () => {
    delete process.env.AGENTDECK_KIT_VARIANT;
    expect(watch.limitsFor({}, null)).toMatchObject({
      floor: 150_000,
      urgent: 260_000,
      window: null,
    });
    expect(run(60_000)).toBeNull();
    expect(run(160_000)).toContain('re-billed');
  });

  it('облако: срочная отметка — 87 % окна из settings.json своего каталога конфигурации', () => {
    // Окно 250k с прежней отметкой 260k: срочная просьба не приходила никогда.
    const config = mkdtempSync(join(state, 'config-'));
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ autoCompactWindow: 250_000 }));
    expect(watch.limitsFor({ CLAUDE_CONFIG_DIR: config })).toMatchObject({
      floor: 150_000,
      urgent: 217_500,
    });
    // Переменная CLI сильнее настройки, как и у самого CLI.
    expect(
      watch.limitsFor({ CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000' }),
    ).toMatchObject({ urgent: 174_000 });
  });

  it('локальный прогон с окном 64k: пороги в тех же долях — 32k / 54k, а не 150k', () => {
    const limits = watch.limitsFor({
      AGENTDECK_KIT_VARIANT: 'local',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '64000',
    });
    expect(limits).toEqual({ floor: 32_000, bucket: 5_333, urgent: 54_400, window: 64_000 });
  });

  it('локальный прогон: на 40k из 64k хук просит записать PROGRESS.md (раньше молчал до 150k)', () => {
    process.env.AGENTDECK_KIT_VARIANT = 'local';
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '64000';
    expect(run(20_000)).toBeNull();
    const message = run(40_000) ?? '';
    expect(message).toContain('40k of 64k');
    expect(message).toContain('.agent/PROGRESS.md (create it if missing)');
    // Счёта за запросы у локальной модели нет — слов про него быть не должно.
    expect(message).not.toContain('re-billed');
    expect(message).not.toContain('/clear');
  });

  it('локальный прогон у границы сжатия: просьба срочная', () => {
    process.env.AGENTDECK_KIT_VARIANT = 'local';
    process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '64000';
    expect(run(58_000)).toContain('compaction near. NOW');
  });

  it('локальный вариант без читаемого окна — прежние числа облака', () => {
    for (const window of ['', 'abc', '500']) {
      expect(
        watch.limitsFor({
          AGENTDECK_KIT_VARIANT: 'local',
          CLAUDE_CODE_AUTO_COMPACT_WINDOW: window,
        }),
      ).toMatchObject({ floor: 150_000, window: null });
    }
  });

  it('окно есть, а вариант не локальный — числа облака (переменная одна, а вариантов два)', () => {
    expect(
      watch.limitsFor({
        AGENTDECK_KIT_VARIANT: 'standard',
        CLAUDE_CODE_AUTO_COMPACT_WINDOW: '64000',
      }),
    ).toMatchObject({ floor: 150_000 });
  });
});

describe('precompact-checkpoint: контрольная точка локального прогона', () => {
  const project = () => mkdtempSync(join(realpathSync(tmpdir()), 'kit-memory-proj-'));

  it('локальный: папка и PROGRESS.md создаются сами, просьба без разговора о счёте', () => {
    process.env.AGENTDECK_KIT_VARIANT = 'local';
    const cwd = project();
    const text = checkpoint.default({ cwd });
    expect(text).toBe(checkpoint.LOCAL_INSTRUCTION);
    expect(text).toContain('create it if missing');
    expect(text).not.toContain('re-billed');
    const file = join(cwd, '.agent', 'PROGRESS.md');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('## In progress');
  });

  it('облачный: без папки .agent/ ничего не создаётся, текст прежний', () => {
    delete process.env.AGENTDECK_KIT_VARIANT;
    const cwd = project();
    expect(checkpoint.default({ cwd })).toBe(checkpoint.INSTRUCTION);
    expect(existsSync(join(cwd, '.agent'))).toBe(false);
  });

  it('локальный: уже написанный файл не затирается, ставится только отметка', () => {
    process.env.AGENTDECK_KIT_VARIANT = 'local';
    const cwd = project();
    mkdirSync(join(cwd, '.agent'));
    const file = join(cwd, '.agent', 'PROGRESS.md');
    writeFileSync(file, '# PROGRESS\n\n## In progress\n- шаг 4\n');
    checkpoint.default({ cwd });
    const body = readFileSync(file, 'utf8');
    expect(body).toMatch(/^<!-- precompact:/);
    expect(body).toContain('- шаг 4');
  });
});

describe('правило local.md: память задачи', () => {
  const rule = readFileSync(join(builtinKitDir(), 'rules', 'local.md'), 'utf8');

  it('просит завести файл и вести его после каждого шага, читать после сжатия и «[Автоматически]»', () => {
    expect(rule).toContain('create it (and `.agent/`) if missing');
    expect(rule).toContain('after every finished step');
    expect(rule).toContain('"[Автоматически]"');
  });
});
