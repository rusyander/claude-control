import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DlpRule } from '@claude-control/contracts';
import { AppStore } from '../lib/app-store.ts';
import { applyPromptGate, describePromptGate, gateScriptPath } from './prompt-gate.ts';
import { buildGateScript } from './prompt-gate/script.ts';
import { saveRules } from './dlp/rules-store.ts';
import { scanText } from './dlp/rules.ts';
import { scanPrompt } from './prompt-gate/gate-core.mjs';

/**
 * Гейт проверяется ЗАПУСКОМ настоящего скрипта настоящим node: смысл хука
 * целиком в кодах возврата, и проверять его чтением кода — значит проверять
 * собственные ожидания.
 */

function rule(patch: Partial<DlpRule> & Pick<DlpRule, 'id' | 'name'>): DlpRule {
  return {
    enabled: true,
    kind: 'terms',
    terms: [],
    pattern: '',
    action: 'mask',
    label: 'ДАННЫЕ',
    ...patch,
  };
}

const NAMES = rule({ id: 'r1', name: 'Сотрудники', terms: ['Рустам Урманов'], label: 'ИМЯ' });
const KEYS = rule({
  id: 'r2',
  name: 'Ключи',
  kind: 'builtin',
  builtin: 'secret_key',
  action: 'block',
});

describe('гейт на промпте', () => {
  let dir: string;
  let hooksDir: string;
  let appDataDir: string;
  let settingsPath: string;
  let store: AppStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gate-'));
    hooksDir = join(dir, 'hooks');
    appDataDir = join(dir, 'claude-control');
    settingsPath = join(dir, 'settings.json');
    mkdirSync(hooksDir, { recursive: true });
    mkdirSync(appDataDir, { recursive: true });
    writeFileSync(settingsPath, '{}', 'utf8');

    store = new AppStore(join(dir, 'state.json'));
    saveRules(appDataDir, [NAMES, KEYS]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const location = () => ({ hooksDir, settingsPath, appDataDir });

  const run = (payload: unknown, action: 'block' | 'warn' = 'block') => {
    const script = join(dir, 'gate-run.mjs');
    writeFileSync(
      script,
      buildGateScript({
        rulesPath: join(appDataDir, 'dlp-rules.json'),
        journalPath: join(appDataDir, 'dlp-journal.jsonl'),
        action,
      }),
      'utf8',
    );
    return spawnSync(process.execPath, [script], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
    });
  };

  it('чистый промпт проходит молча', () => {
    const result = run({ hook_event_name: 'UserPromptSubmit', user_prompt: 'почини сборку' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('совпадение при действии «отклонить» останавливает отправку', () => {
    const result = run({ user_prompt: 'спроси у Рустама Урманова' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Сотрудники');
  });

  it('в тексте отказа нет самого значения', () => {
    const result = run({ user_prompt: 'спроси у Рустама Урманова' });
    expect(result.stderr).not.toContain('Урманов');
  });

  it('при действии «предупредить» промпт уходит, но с сообщением', () => {
    const result = run({ user_prompt: 'спроси у Рустама Урманова' }, 'warn');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain('Сотрудники');
  });

  it('правило «отклонить» останавливает промпт даже в режиме предупреждения', () => {
    // Иначе общая настройка молча понижала бы запрет до уведомления.
    const result = run({ user_prompt: 'ключ sk-abcdef0123456789xyz' }, 'warn');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Ключи');
  });

  it('неузнанная форма ввода не блокирует, но говорит об этом', () => {
    // Блокировать каждый промпт из-за смены формата — сломать человеку работу.
    const result = run({ hook_event_name: 'UserPromptSubmit', unexpected: 'shape' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain('НЕ проверен');
  });

  it('испорченный файл правил не блокирует, но говорит об этом', () => {
    writeFileSync(join(appDataDir, 'dlp-rules.json'), '{ не json', 'utf8');
    const result = run({ user_prompt: 'спроси у Рустама Урманова' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).systemMessage).toContain('НЕ проверен');
  });

  it('в журнале нет значений — только правило и счётчик', () => {
    run({ user_prompt: 'спроси у Рустама Урманова' });
    const raw = readFileSync(join(appDataDir, 'dlp-journal.jsonl'), 'utf8');
    expect(raw).toContain('Сотрудники');
    expect(raw).not.toContain('Урманов');
  });

  it('в самом скрипте нет ни одной записи словаря', () => {
    // Файл хука уезжает с переносом окружения: словарь внутри него был бы
    // утечкой через средство защиты.
    const text = buildGateScript({ rulesPath: 'x', journalPath: '', action: 'block' });
    expect(text).not.toContain('Урманов');
  });

  it('установка кладёт скрипт и прописывает хук', () => {
    const info = applyPromptGate(store, location(), { enabled: true, action: 'block' });

    expect(info.installed).toBe(true);
    expect(existsSync(gateScriptPath(hooksDir))).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(command).toContain('claude-control-prompt-gate.mjs');
  });

  it('снятие убирает и запись, и файл', () => {
    applyPromptGate(store, location(), { enabled: true, action: 'block' });
    const info = applyPromptGate(store, location(), { enabled: false, action: 'block' });

    expect(info.installed).toBe(false);
    expect(existsSync(gateScriptPath(hooksDir))).toBe(false);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks.UserPromptSubmit ?? []).toEqual([]);
  });

  it('правку человека не затирает и не удаляет', () => {
    applyPromptGate(store, location(), { enabled: true, action: 'block' });
    writeFileSync(gateScriptPath(hooksDir), '// моя правка\n', 'utf8');

    const info = applyPromptGate(store, location(), { enabled: true, action: 'warn' });
    expect(info.customized).toBe(true);
    expect(readFileSync(gateScriptPath(hooksDir), 'utf8')).toBe('// моя правка\n');

    // Снятие тоже не выбрасывает чужой файл — только снимает регистрацию.
    applyPromptGate(store, location(), { enabled: false, action: 'warn' });
    expect(existsSync(gateScriptPath(hooksDir))).toBe(true);
  });

  it('явная переустановка возвращает свой скрипт', () => {
    applyPromptGate(store, location(), { enabled: true, action: 'block' });
    writeFileSync(gateScriptPath(hooksDir), '// моя правка\n', 'utf8');

    const info = applyPromptGate(
      store,
      location(),
      { enabled: true, action: 'block' },
      { force: true },
    );
    expect(info.customized).toBe(false);
  });

  it('сводка считает включённые правила и отдельно запрещающие', () => {
    const info = describePromptGate(store, location());
    expect(info.rulesCount).toBe(2);
    expect(info.blockRulesCount).toBe(1);
  });

  it('битый файл правил виден в сводке как проблема', () => {
    writeFileSync(join(appDataDir, 'dlp-rules.json'), '{ не json', 'utf8');
    expect(describePromptGate(store, location()).problem).toBeTruthy();
  });
});

describe('ядро гейта совпадает с прокси', () => {
  // Логика поиска существует в одном файле (`gate-core.mjs`), но прокси ходит
  // через `rules.ts`. Тест держит обе реализации на одном наборе примеров:
  // разойдутся — упадёт сборка, а не защита пользователя.
  const RULES: DlpRule[] = [
    NAMES,
    KEYS,
    rule({ id: 'r3', name: 'Почта', kind: 'builtin', builtin: 'email' }),
    rule({ id: 'r4', name: 'ИНН', kind: 'builtin', builtin: 'inn' }),
    rule({ id: 'r5', name: 'Карта', kind: 'builtin', builtin: 'card' }),
    rule({ id: 'r6', name: 'Телефон', kind: 'builtin', builtin: 'phone_ru' }),
    rule({ id: 'r7', name: 'Договор', kind: 'regex', pattern: 'ДОГ-\\d{4}' }),
  ];

  const SAMPLES = [
    'ничего интересного',
    'спроси у Рустама Урманова про ДОГ-1234',
    'Ивановский переулок — не Иванов',
    'почта a.b@example.com и телефон +7 999 123-45-67',
    'ИНН 7707083893, а 1234567890 — не ИНН',
    'карта 4111 1111 1111 1111, а 4111 1111 1111 1112 — нет',
    'ключ sk-abcdef0123456789xyz внутри текста',
    'Рустам Урманов, Рустама Урманова, РУСТАМ УРМАНОВ',
  ];

  for (const sample of SAMPLES) {
    it(`совпадают на: ${sample.slice(0, 40)}`, () => {
      const fromProxy = scanText(sample, RULES).map((match) => [
        match.ruleId,
        match.start,
        match.end,
      ]);
      const fromGate = (
        scanPrompt(sample, RULES) as { ruleId: string; start: number; end: number }[]
      ).map((match) => [match.ruleId, match.start, match.end]);
      expect(fromGate).toEqual(fromProxy);
    });
  }
});
