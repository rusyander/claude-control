import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RUN_INPUT_KEEP } from '@agentdeck/contracts/run-input';
import { appendRunInput, moveRunInputs, readRunInputs } from './run-input.ts';

/**
 * Хранилище «что получил агент» (U8): настоящие файлы во временном каталоге.
 * Главное здесь — дословность: предел режет число прогонов, а не текст.
 */
describe('run-input', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-run-input-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('свежие первыми, а текст в сотни килобайт — целиком', () => {
    const long = 'x'.repeat(300_000);
    appendRunInput(dir, 'sess-1', { startedAt: 1, prompt: 'первый' });
    appendRunInput(dir, 'sess-1', { startedAt: 2, prompt: long, appendSystemPrompt: long });

    const runs = readRunInputs(dir, 'sess-1');
    expect(runs.map((run) => run.startedAt)).toEqual([2, 1]);
    expect(runs[0]?.prompt).toHaveLength(300_000);
    expect(runs[0]?.appendSystemPrompt).toHaveLength(300_000);
  });

  it('сверх предела уходят самые давние прогоны', () => {
    for (let at = 1; at <= RUN_INPUT_KEEP + 2; at += 1) {
      appendRunInput(dir, 'sess-1', { startedAt: at, prompt: `ход ${at}` });
    }
    const runs = readRunInputs(dir, 'sess-1');
    expect(runs).toHaveLength(RUN_INPUT_KEEP);
    expect(runs.at(-1)?.startedAt).toBe(3);
  });

  /**
   * Прогон чужого CLI сообщает вход, когда путь его принял (TQ-09), а путь,
   * не поднявшийся после этого, уступает следующему: вход того же прогона
   * (тот же `startedAt`) заменяет прежний, а не встаёт второй записью.
   */
  it('повторный вход того же прогона заменяет запись, а не дописывает вторую (TQ-09)', () => {
    appendRunInput(dir, 'codex:abc', { startedAt: 1, prompt: 'прошлый ход' });
    appendRunInput(dir, 'codex:abc', { startedAt: 2, prompt: 'хвост сессии' });
    appendRunInput(dir, 'codex:abc', { startedAt: 2, prompt: 'полный промпт' });

    expect(readRunInputs(dir, 'codex:abc').map((run) => run.prompt)).toEqual([
      'полный промпт',
      'прошлый ход',
    ]);
  });

  it('ключ чужого CLI с двоеточием ложится файлом и читается обратно', () => {
    appendRunInput(dir, 'codex:abc', { startedAt: 1, prompt: 'p' });
    expect(readRunInputs(dir, 'codex:abc')).toHaveLength(1);
    expect(readdirSync(join(dir, 'run-inputs'))).toEqual(['codex%3Aabc.json']);
  });

  it('нет записей или битый файл — пустой список', () => {
    expect(readRunInputs(dir, 'nope')).toEqual([]);
    mkdirSync(join(dir, 'run-inputs'), { recursive: true });
    writeFileSync(join(dir, 'run-inputs', 'bad.json'), '{oops');
    expect(readRunInputs(dir, 'bad')).toEqual([]);
  });

  it('временный ключ сменился настоящим — записи едут за ним', () => {
    appendRunInput(dir, 'new-1', { startedAt: 5, prompt: 'задание звена' });
    moveRunInputs(dir, 'new-1', 'sess-9');

    expect(readRunInputs(dir, 'sess-9').map((run) => run.prompt)).toEqual(['задание звена']);
    expect(readRunInputs(dir, 'new-1')).toEqual([]);
  });

  it('у настоящего ключа записи уже есть — сливаются по времени, временный файл уходит', () => {
    appendRunInput(dir, 'sess-9', { startedAt: 1, prompt: 'раньше' });
    appendRunInput(dir, 'new-1', { startedAt: 7, prompt: 'позже' });
    moveRunInputs(dir, 'new-1', 'sess-9');

    expect(readRunInputs(dir, 'sess-9').map((run) => run.startedAt)).toEqual([7, 1]);
    expect(existsSync(join(dir, 'run-inputs', 'new-1.json'))).toBe(false);
  });
});
