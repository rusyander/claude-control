import { describe, expect, it } from 'vitest';
import { isServerMessageCode } from '@agentdeck/contracts/server-messages';
import {
  attachTextCodes,
  localizeText,
  matchText,
  serverText,
  type ServerTextCode,
} from './server-texts.ts';
import { serverTextTemplates } from './server-texts/templates.ts';

const CODES = Object.keys(serverTextTemplates) as ServerTextCode[];

function sampleParams(code: ServerTextCode): Record<string, string> {
  const names = [...serverTextTemplates[code].ru.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map(
    (match) => match[1] as string,
  );
  return Object.fromEntries(names.map((name, index) => [name, `v${index}-${name}`]));
}

describe('server-texts: шаблоны разбираются однозначно', () => {
  it.each(CODES.filter((code) => code !== 'gateway-joined'))(
    '%s: текст по коду разбирается обратно в тот же код',
    (code) => {
      expect(isServerMessageCode(code)).toBe(true);
      const params = sampleParams(code);
      const matched = matchText(serverText(code, params));
      expect(matched?.messageCode).toBe(code);
      expect(matched?.params ?? {}).toEqual(params);
    },
  );

  it('склейка принимается только с известной головой', () => {
    const head = serverText('gateway-upstream-401');
    expect(matchText(`${head}: чужая фраза контура`)).toEqual({
      messageCode: 'gateway-joined',
      params: {
        message: { messageCode: 'gateway-upstream-401' },
        detail: 'чужая фраза контура',
      },
    });
    expect(matchText('что-то своё: чужая фраза')).toBeUndefined();
  });

  it('вложенный текст переводится целиком, слова контура остаются как есть', () => {
    const inner = serverText('gateway-no-connection', { reason: 'fetch failed' });
    const outer = serverText('gateway-prefixed', { message: inner });
    expect(localizeText(outer, 'en')).toBe('AgentDeck: No connection to the contour: fetch failed');
    expect(localizeText(outer, 'ru')).toBe(outer);
    expect(localizeText('ответ контура как есть', 'en')).toBe('ответ контура как есть');
  });

  it('код вешается на поля ответа вглубь, чужой текст и готовый код не трогаются', () => {
    const detail = serverText('gateway-headers-timeout', { seconds: 10 });
    const result = attachTextCodes(
      {
        health: { detail, title: 'Мой контур' },
        notes: [serverText('gateway-flaw-empty'), 'своё'],
        message: 'уже с кодом',
        messageCode: 'gateway-flaw-empty',
      },
      ['notes'],
    );
    expect(result).toMatchObject({
      health: { detail, detailCode: 'gateway-headers-timeout', detailParams: { seconds: '10' } },
      notesCodes: [{ messageCode: 'gateway-flaw-empty' }, null],
      messageCode: 'gateway-flaw-empty',
    });
    expect(result.health).not.toHaveProperty('titleCode');
    expect(result).not.toHaveProperty('params');
  });
});
