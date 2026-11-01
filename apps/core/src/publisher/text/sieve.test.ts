import { describe, expect, it } from 'vitest';
import { TEXT_KINDS, type TextVerdict } from '@agentdeck/contracts/core/publish';
import { sieveText, type TextSieveContext } from './index.ts';

/**
 * P62: каждое правило сита — свой тест и свой убитый мутант; чистый текст уходит байт в байт.
 * Имена компаний — примеры (`Example Corp`), реальных в отслеживаемых файлах нет (G9).
 */

const ctx: TextSieveContext = {
  config: { companyNames: ['Example Corp', 'Acme'], requireSignOff: false },
  convention: null,
  localRoots: ['/var/tmp/adk-copy-1'],
};

const rules = (v: TextVerdict) => (v.kind === 'refused' ? v.spans.map((s) => s.rule) : []);
const spanned = (text: string, v: TextVerdict) =>
  v.kind === 'refused' ? v.spans.map((s) => text.slice(s.start, s.end)) : [];

/** Части ключа и id собираются в рантайме: литерал формы в исходнике ловят сканеры секретов. */
const V7 = ['0192f3a4', 'b5c6', '7d8e', '9f01', '23456789abcd'].join('-');
const V4 = ['3f2504e0', '4f89', '41d3', '9a0c', '0305e82c3301'].join('-');
const FP = 'ab'.repeat(32);
const KEY = ['ghp', 'FAKEfakeFAKEfakeFAKEfake0000'].join('_');

describe('publisher/text sieve', () => {
  it('a clean text passes byte-identical', () => {
    const text =
      'fix: retry the token refresh once on 401\n\nThe refresh raced the first request; commit 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b is reverted.\n';
    const verdict = sieveText('commit', text, ctx);
    expect(verdict).toEqual({ kind: 'pass', text });
    expect(verdict.kind === 'pass' && verdict.text === text).toBe(true);
  });

  it('trailer: attribution lines are stripped, the rest kept', () => {
    const text = [
      'feat: add export button',
      '',
      'Exports the table as CSV.',
      '',
      `Claude-Session: ${V7}`,
      'Co-Authored-By: Bot <bot@example.com>',
      '🤖 Generated with [Claude Code](https://example.com)',
      '',
    ].join('\n');
    const verdict = sieveText('commit', text, ctx);
    expect(verdict).toEqual({
      kind: 'stripped',
      text: 'feat: add export button\n\nExports the table as CSV.\n',
      removed: [
        { rule: 'trailer', line: `Claude-Session: ${V7}` },
        { rule: 'trailer', line: 'Co-Authored-By: Bot <bot@example.com>' },
        { rule: 'trailer', line: '🤖 Generated with [Claude Code](https://example.com)' },
      ],
    });
  });

  it('trailer: Signed-off-by stays only on a commit the config or history requires it for', () => {
    const text = 'fix: x\n\nSigned-off-by: Dev <dev@example.com>';
    expect(sieveText('commit', text, ctx).kind).toBe('stripped');
    const required = { ...ctx, config: { ...ctx.config, requireSignOff: true } };
    expect(sieveText('commit', text, required)).toEqual({ kind: 'pass', text });
    const history = {
      ...ctx,
      convention: { conventional: true, language: 'en', signedOffShare: 0.9 },
    };
    expect(sieveText('commit', text, history)).toEqual({ kind: 'pass', text });
    expect(sieveText('mr-body', text, required).kind).toBe('stripped');
  });

  it('uuidv7: a core id is refused with its span', () => {
    const text = `Fixes the export for task ${V7}.`;
    const verdict = sieveText('mr-body', text, ctx);
    expect(rules(verdict)).toEqual(['uuidv7']);
    expect(spanned(text, verdict)).toEqual([V7]);
  });

  it('record-id: another uuid, a sha256 fingerprint and an agentdeck label are refused; a commit sha is not', () => {
    const text = `Run ${V4} passed, profile ${FP}, label agentdeck-split-3f2a91; see 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b.`;
    const verdict = sieveText('reply', text, ctx);
    expect(rules(verdict)).toEqual(['record-id', 'record-id', 'record-id']);
    expect(spanned(text, verdict)).toEqual([V4, FP, 'agentdeck-split-3f2a91']);
  });

  it('local-path: drive letters, home dirs, ~/ and the copy root are refused; URLs are not', () => {
    const text =
      'Logs in C:\\Users\\dev\\out.txt and /home/dev/x, config ~/.claude/a, copy /var/tmp/adk-copy-1/src. See https://example.com/home/docs and https://example.com/Users/list.';
    const verdict = sieveText('tracker-comment', text, ctx);
    expect(rules(verdict)).toEqual(['local-path', 'local-path', 'local-path', 'local-path']);
    expect(spanned(text, verdict)).toEqual([
      'C:\\Users\\dev\\out.txt',
      '/home/dev/x',
      '~/.claude/a',
      '/var/tmp/adk-copy-1/src',
    ]);
  });

  it('company-name: a configured name is refused as a whole word, any case', () => {
    const text = 'Works for EXAMPLE CORP clients; acmeville stays.';
    const verdict = sieveText('mr-title', text, ctx);
    expect(rules(verdict)).toEqual(['company-name']);
    expect(spanned(text, verdict)).toEqual(['EXAMPLE CORP']);
    expect(
      sieveText('mr-title', text, { ...ctx, config: { ...ctx.config, companyNames: [] } }),
    ).toEqual({ kind: 'pass', text });
  });

  it('process-word: narration shapes outside code are refused; plain words and code are not', () => {
    const text =
      'Fixed in round 3 after step #2; the core narrowed run. Step through the list, run `step 4`.\n```\nreplay 9\n```\nШаг 5 готов.';
    const verdict = sieveText('reply', text, ctx);
    expect(rules(verdict)).toEqual([
      'process-word',
      'process-word',
      'process-word',
      'process-word',
      'process-word',
    ]);
    expect(spanned(text, verdict)).toEqual([
      'round 3',
      'step #2',
      'the core',
      'narrowed run',
      'Шаг 5',
    ]);
  });

  it('secret: a planted token is refused in every kind (P61 text sink)', () => {
    const text = `Use token ${KEY} for the call.`;
    for (const kind of TEXT_KINDS) {
      const verdict = sieveText(kind, text, ctx);
      expect(rules(verdict)).toEqual(['secret']);
      expect(spanned(text, verdict)).toEqual([KEY]);
    }
  });

  it('a refusal inside a stripped trailer line does not count', () => {
    const text = `fix: x\n\nClaude-Session: ${V7}\n`;
    expect(sieveText('commit', text, ctx)).toEqual({
      kind: 'stripped',
      text: 'fix: x\n',
      removed: [{ rule: 'trailer', line: `Claude-Session: ${V7}` }],
    });
  });

  it('P80 half: one input gives the same verdict whichever text kind carries it', () => {
    const samples = [
      'Adds the CSV export.',
      `Ref ${V7}`,
      'Co-Authored-By: Bot <bot@example.com>\nBody',
      'Built in round 2.',
    ];
    for (const text of samples) {
      const verdicts = TEXT_KINDS.map((kind) => sieveText(kind, text, ctx));
      for (const v of verdicts) expect(v).toEqual(verdicts[0]);
    }
  });
});
