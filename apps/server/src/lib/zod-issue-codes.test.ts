import { describe, expect, it } from 'vitest';
import {
  mediaImageRequestSchema,
  mediaPictureBlockRequestSchema,
} from '@agentdeck/contracts/media';
import {
  mediaDeckBlockRequestSchema,
  mediaDeckRequestSchema,
} from '@agentdeck/contracts/media-deck';
import { isServerMessageCode } from '@agentdeck/contracts/server-messages';
import { issueBody, singleIssueCode } from './zod-issue-codes.ts';

/** Проблема настоящей схемы контракта — а не строка, набранная в тесте руками. */
function issuesOf(schema: { safeParse: (value: unknown) => unknown }, value: unknown) {
  const parsed = schema.safeParse(value) as {
    success: boolean;
    error?: { issues: { message: string }[] };
  };
  expect(parsed.success).toBe(false);
  return parsed.error!.issues;
}

describe('zod-issue-codes', () => {
  it.each([
    [mediaImageRequestSchema, { prompt: '   ' }, 'media-prompt-empty'],
    [mediaImageRequestSchema, { prompt: 'x'.repeat(4001) }, 'media-prompt-too-long'],
    [mediaPictureBlockRequestSchema, { block: '' }, 'media-block-empty'],
    [mediaDeckRequestSchema, { prompt: '' }, 'media-deck-topic-empty'],
    [mediaDeckRequestSchema, { prompt: 'x'.repeat(4001) }, 'media-deck-topic-too-long'],
    [mediaDeckBlockRequestSchema, { block: '' }, 'media-block-empty'],
  ])('текст схемы контракта находит свой код (%#)', (schema, body, code) => {
    const issues = issuesOf(schema, body);
    const result = issueBody(issues, 'запасная');
    expect(result).toEqual({ message: issues[0]!.message, messageCode: code });
    expect(isServerMessageCode(result.messageCode)).toBe(true);
  });

  it('незнакомая проблема (английский текст zod) уходит без кода', () => {
    const issues = issuesOf(mediaImageRequestSchema, { prompt: 42 });
    expect(issueBody(issues, 'запасная').messageCode).toBeUndefined();
  });

  it('без проблем — запасная фраза маршрута со своим кодом', () => {
    expect(issueBody([], 'Запрос на картинку не разобран.', 'media-image-request-invalid')).toEqual(
      {
        message: 'Запрос на картинку не разобран.',
        messageCode: 'media-image-request-invalid',
      },
    );
  });

  it('склеенный список нескольких проблем кода не получает', () => {
    const one = [{ message: 'последняя реплика должна быть человека' }];
    expect(singleIssueCode(one)).toBe('panel-agent-last-not-user');
    expect(singleIssueCode([...one, { message: 'блок пустой' }])).toBeUndefined();
  });
});
