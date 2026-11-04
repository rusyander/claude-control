import { describe, expect, it } from 'vitest';
import {
  formatServerMessage,
  isServerMessageCode,
  type ServerMessageCode,
} from '@agentdeck/contracts/server-messages';
import { serverMessagesEn } from '../../config/i18n/server-messages/en.ts';
import { serverMessagesRu } from '../../config/i18n/server-messages/ru.ts';
import { runErrorText } from './error-text';
import { applyEvent, getRun, setRun } from './store';

/**
 * Отказ ядра в ходе чата на телефоне (s10 G7): сервер шлёт текст панели по коду с флагом `panel`;
 * экран чата показывает перевод кода на языке телефона, а не русскую строку сервера и не
 * английскую фразу ядра. Строка CLI без флага идёт как есть. Стор живёт без react-native.
 */
const dictOf =
  (dict: Record<ServerMessageCode, string>) =>
  (code: string, params?: Record<string, string>): string | undefined =>
    isServerMessageCode(code) ? formatServerMessage(dict[code], params ?? {}) : undefined;

const RU_TEXT = serverMessagesRu['core-chat-contour-down'].replace('{{contour}}', 'c1');

describe('store + runErrorText — coded panel refusal in the phone chat', () => {
  it('a panel-coded error shows the phone-language text; the raw server line is kept for equality', () => {
    setRun('m-g7-1', { status: 'running' });
    applyEvent('m-g7-1', {
      kind: 'error',
      message: RU_TEXT,
      code: 'core-chat-contour-down',
      params: { contour: 'c1' },
      panel: true,
    });
    const run = getRun('m-g7-1');
    expect(run.error).toBe(RU_TEXT);
    expect(runErrorText(run, dictOf(serverMessagesEn))).toContain(
      'the required contour c1 is unavailable',
    );
    expect(runErrorText(run, dictOf(serverMessagesRu))).toBe(RU_TEXT);
  });

  it('a CLI error without the panel flag is shown as is, even with a code', () => {
    setRun('m-g7-2', { status: 'running' });
    applyEvent('m-g7-2', {
      kind: 'error',
      message: 'API Error: 529 overloaded',
      code: 'cli-outdated',
    });
    expect(runErrorText(getRun('m-g7-2'), dictOf(serverMessagesEn))).toBe(
      'API Error: 529 overloaded',
    );
  });
});
