import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProvider } from '../registry.ts';
import { gooseConfigDir } from './config-dirs.ts';

/**
 * Goose 1.53 (L-goose, 06.10.2026). Фикстуры — НАСТОЯЩИЙ stdout `goose run` на
 * заглушке модели (`__fixtures__/goose-1.53-*`): один вызов инструмента и ответ
 * тремя кусками. Временные пути и id в них заменены, остальное — байт в байт.
 */
const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), 'utf8');

const goose = getProvider('goose');
const assistant = goose.assistant!;

/** Прогнать stdout через разборщик кусками заданной длины — как его отдаёт труба. */
function parse(stdout: string, size: number): string {
  const parser = assistant.parseStdout!();
  let out = '';
  for (let at = 0; at < stdout.length; at += size) out += parser.push(stdout.slice(at, at + size));
  return out + parser.end();
}

describe('goose: одиночный запуск', () => {
  it('argv просит поток JSON без заставки; промпт — отдельный последний элемент', () => {
    expect(assistant.oneShotArgs?.('вопрос "с кавычками"')).toEqual([
      'run',
      '--no-session',
      '-q',
      '--output-format',
      'stream-json',
      '-t',
      'вопрос "с кавычками"',
    ]);
  });

  it('«Разрешить правки» доходит режимом GOOSE_MODE: выкл — chat, вкл — auto, нет поля — как было', () => {
    // approve/smart_approve в `run` нельзя: без терминала Goose 1.53 обрывает весь
    // прогон на первом же инструменте («invalid configuration»), снято живьём.
    expect(assistant.oneShotEnv?.({ allowEdits: false })).toEqual({ GOOSE_MODE: 'chat' });
    expect(assistant.oneShotEnv?.({ allowEdits: true })).toEqual({ GOOSE_MODE: 'auto' });
    expect(assistant.oneShotEnv?.({})).toBeUndefined();
    expect(assistant.oneShotEnv?.()).toBeUndefined();
    expect(assistant.editsControl).toBe('flag');
  });

  it('поток JSON → только текст ассистента; инструмент и его вывод в ответ не попадают', () => {
    const stdout = fixture('goose-1.53-run-stream-json.jsonl');
    const want = 'Сначала проверю. \n\nГотово: файл на месте.';
    // Любая нарезка трубы даёт тот же ответ: строка JSON может прийти по частям.
    for (const size of [1, 7, 64, stdout.length]) expect(parse(stdout, size)).toBe(want);
  });

  it('текстовый вывод прежнего argv — заставка и инструмент прямо в ответе (то, от чего уходим)', () => {
    const text = fixture('goose-1.53-run-text.txt');
    expect(text).toContain('goose is ready');
    expect(text).toContain('▸ shell');
    expect(text).toContain('fixture-probeГотово');
  });

  it('строки не-JSON и чужие события пропускаются, хвост без перевода строки дочитывается', () => {
    const line = (text: string) =>
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      });
    const stdout = [
      'warning: что-то своё',
      JSON.stringify({ type: 'notification', extension_id: 'x', message: 'шум' }),
      JSON.stringify({ type: 'model_change', model: 'm', mode: 'auto' }),
      line('раз '),
      JSON.stringify({
        type: 'message',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'мысли' }] },
      }),
      line('два'),
    ].join('\n');
    expect(parse(stdout, 5)).toBe('раз два');
  });
});

describe('goose: скиллы и плагины', () => {
  it('скиллы — свой каталог `skills` рядом с config.yaml; общие каталоги только названы', () => {
    expect(goose.capabilities.skills).toBe('ready');
    expect(goose.skillsConfig?.format).toBe('skill-md-dir');
    expect(goose.skillsConfig?.dir()).toBe(join(gooseConfigDir(), 'skills'));
    expect(goose.skillsConfig?.alsoLoadedFrom?.()).toEqual([
      join(homedir(), '.agents', 'skills'),
      join(homedir(), '.claude', 'skills'),
    ]);
    expect(goose.projectConfig?.skills).toEqual({
      format: 'skill-md-dir',
      relativeDir: '.agents/skills',
    });
  });

  it('плагины — не поддержаны: адаптера нет, раздел закрыт', () => {
    expect(goose.capabilities.plugins).toBe('unsupported');
    expect(goose.pluginsConfig).toBeUndefined();
  });
});
