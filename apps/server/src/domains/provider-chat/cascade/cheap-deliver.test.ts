import { describe, it, expect } from 'vitest';
import { cheapDeliverEffort, isModelRefusal } from './cheap-deliver.ts';

describe('cheap-deliver', () => {
  describe('cheapDeliverEffort', () => {
    it('keeps a known effort at or below the tier cap', () => {
      expect(cheapDeliverEffort('low', 'medium')).toBe('low');
      expect(cheapDeliverEffort('medium', 'medium')).toBe('medium');
    });

    it('caps an effort above the tier cap', () => {
      expect(cheapDeliverEffort('high', 'medium')).toBe('medium');
      expect(cheapDeliverEffort('xhigh', 'medium')).toBe('medium');
    });

    it('unknown work effort gets the tier cap, never high', () => {
      expect(cheapDeliverEffort('max', 'medium')).toBe('medium');
    });

    it('absent work effort sends no flag: the CLI config decides, as without the lever', () => {
      expect(cheapDeliverEffort(undefined, 'medium')).toBeUndefined();
      expect(cheapDeliverEffort('', 'medium')).toBeUndefined();
      expect(cheapDeliverEffort('  ', 'medium')).toBeUndefined();
    });

    it('keeps an effort below the panel ladder (Codex minimal/none)', () => {
      expect(cheapDeliverEffort('minimal', 'medium')).toBe('minimal');
      expect(cheapDeliverEffort('None', 'medium')).toBe('none');
    });

    it('no known tier cap sends no effort flag', () => {
      expect(cheapDeliverEffort('xhigh', undefined)).toBeUndefined();
      expect(cheapDeliverEffort('low', 'turbo')).toBeUndefined();
    });
  });

  describe('isModelRefusal', () => {
    const model = 'gpt-5.3-codex-spark';

    it('recognises the real codex 0.155.1 refusal texts', () => {
      expect(
        isModelRefusal(
          'unexpected status 404 Not Found: The model `gpt-5.3-codex-spark` does not exist or you ' +
            'do not have access to it., url: http://127.0.0.1:50473/v1/responses',
          model,
        ),
      ).toBe(true);
      expect(
        isModelRefusal(
          '{"detail":"The \'gpt-5.3-codex-spark\' model is not supported when using Codex with a ChatGPT account."}',
          model,
        ),
      ).toBe(true);
    });

    it('recognises error codes and the Gemini shape (synthetic)', () => {
      expect(isModelRefusal('{"error":{"code":"model_not_found"}}', model)).toBe(true);
      expect(isModelRefusal('400 Bad Request: Unsupported model', model)).toBe(true);
      expect(
        isModelRefusal(
          '[API Error: models/gemini-3-flash-lite is not found for API version v1beta]',
          'gemini-3-flash-lite',
        ),
      ).toBe(true);
    });

    it('limits, auth, network and bare exit codes are not a model refusal', () => {
      for (const error of [
        undefined,
        '',
        'Rate limit reached for gpt-5.3-codex-spark in organization org-x',
        "You've hit your usage limit for gpt-5.3-codex-spark. Try again later.",
        'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
        'stream disconnected before completion: error sending request',
        'CLI завершился с кодом 1',
        'file not found: src/app.ts',
        // Имя модели и «access denied» в разных строках: отказ `git push`, не модели.
        'model: gpt-5.3-codex-spark\nremote: Permission to org/repo.git denied\nfatal: access denied',
      ]) {
        expect(isModelRefusal(error, model), String(error)).toBe(false);
      }
    });
  });
});
