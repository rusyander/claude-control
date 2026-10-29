import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';
import { agentdeckCorePlugin } from '../../../../../tools/eslint-rules/no-absent-in-catch.mjs';

/**
 * Правило линтера к P44 отдельным файлом: оно не зависит от ОС, а Linux-прогон ядра
 * (`tools/core-linux.mjs`) копирует в контейнер только `apps/core` и `packages/*` — без `tools/`.
 */

describe('lint rule no-absent-in-catch', () => {
  it('P44 lint: absent produced inside a catch is an error; outside a catch and in a nested function it is not', () => {
    const linter = new Linter({ configType: 'flat' });
    const config = [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { 'agentdeck-core': agentdeckCorePlugin },
        rules: { 'agentdeck-core/no-absent-in-catch': 'error' as const },
      },
    ];
    const lint = (code: string) =>
      linter.verify(code, config, 'x.ts').filter((m) => m.ruleId?.endsWith('no-absent-in-catch'));
    expect(lint('function f(){ try { g(); } catch { return absent(); } }')).toHaveLength(1);
    expect(lint('function f(){ try { g(); } catch { return ABSENT; } }')).toHaveLength(1);
    expect(lint('function f(){ try { g(); } catch { return { absent: true }; } }')).toHaveLength(1);
    expect(
      lint('function f(){ try { g(); } catch (e) { return { unknown: String(e) }; } }'),
    ).toHaveLength(0);
    expect(lint('function f(){ if (x) return absent(); return ABSENT; }')).toHaveLength(0);
    expect(lint('function f(){ try { g(); } catch { h(() => absent()); } }')).toHaveLength(0);
    expect(lint("import { ABSENT } from './a'; const ABSENT2 = 1;")).toHaveLength(0);
  });

  it('F-81 the async twin of catch and a finally block are catch bodies too', () => {
    const linter = new Linter({ configType: 'flat' });
    const config = [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: tseslint.parser },
        plugins: { 'agentdeck-core': agentdeckCorePlugin },
        rules: { 'agentdeck-core/no-absent-in-catch': 'error' as const },
      },
    ];
    const lint = (code: string) =>
      linter.verify(code, config, 'x.ts').filter((m) => m.ruleId?.endsWith('no-absent-in-catch'));
    // Обработчик отказа промиса — `catch` асинхронного чтения.
    expect(lint('const r = g().catch(() => ABSENT);')).toHaveLength(1);
    expect(lint('const r = g().catch(() => absent());')).toHaveLength(1);
    expect(lint('const r = g().catch(function () { return { absent: true }; });')).toHaveLength(1);
    expect(lint('const r = g().then(ok, () => ABSENT);')).toHaveLength(1);
    expect(lint('const r = g()?.catch(async (e) => { log(e); return ABSENT; });')).toHaveLength(1);
    // `finally` идёт и после сбоя: «нет» оттуда перекрывает исключение.
    expect(lint('function f(){ try { g(); } finally { return ABSENT; } }')).toHaveLength(1);
    // Не обработчик отказа: первый аргумент `then`, свой `catch` объекта не-промиса с другим именем.
    expect(lint('const r = g().then(() => ABSENT);')).toHaveLength(0);
    expect(lint('const r = g().then((v) => v, (e) => ({ unknown: String(e) }));')).toHaveLength(0);
    expect(lint('const r = g().catch((e) => ({ unknown: String(e) }));')).toHaveLength(0);
    // Функция, объявленная в обработчике и вызванная позже, — своя судьба (как в catch).
    expect(lint('const r = g().catch(() => { later(() => absent()); return x; });')).toHaveLength(
      0,
    );
  });
});
