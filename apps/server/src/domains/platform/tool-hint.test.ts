import { describe, it, expect } from 'vitest';
import { looksLikeToolCall, modelSizeB } from '@agentdeck/contracts/platform-tool-hint';

/**
 * Узкая грамматика «ответ целиком — вызов текстом»: подсказка о прослойке не
 * должна срабатывать на объяснение с примером, иначе её перестанут читать.
 */

describe('looksLikeToolCall', () => {
  it.each([
    ['голый JSON', '{"name":"Write","arguments":{"file_path":"a.txt"}}'],
    ['ограждение json', '```json\n{"name":"Bash","parameters":{"command":"ls"}}\n```'],
    ['обёртка function', '{"type":"function","function":{"name":"Read","arguments":"{}"}}'],
    ['tool_calls', '{"tool_calls":[{"function":{"name":"Read","arguments":"{}"}}]}'],
    ['теги протокола', '<tool_call>{"name":"Edit","input":{}}</tool_call>'],
    ['размышления до вызова', '<think>надо записать</think>\n{"name":"Write","input":{}}'],
  ])('%s — похоже на вызов', (_, text) => {
    expect(looksLikeToolCall(text)).toBe(true);
  });

  it.each([
    ['обычный ответ', 'Готово, файл записан.'],
    ['объект с текстом вокруг', 'Вот так: {"name":"Write","arguments":{}} — пример'],
    ['JSON без аргументов', '{"name":"Иван"}'],
    ['два ограждения', '```json\n{"name":"a","input":{}}\n```\n```\nx\n```'],
    ['пусто', '   '],
    ['данные, а не вызов', '{"items":[1,2]}'],
  ])('%s — не вызов', (_, text) => {
    expect(looksLikeToolCall(text)).toBe(false);
  });
});

describe('modelSizeB', () => {
  it.each([
    ['qwen2.5:7b', 7],
    ['Qwen3-32B-Instruct', 32],
    ['gemma-3-27b-it', 27],
    ['qwen3-30b-a3b', 30],
    ['gpt-x', undefined],
    ['llama3.1:8b-instruct-q4', 8],
  ])('%s → %s', (model, size) => {
    expect(modelSizeB(model)).toBe(size);
  });
});
