import { describe, expect, it } from 'vitest';
import { appliesAlways } from './appliesAlways';
import { ruleFormat } from './ruleFormat';

describe('ruleFormat', () => {
  it('расширение по формату: .mdc у Cursor, .md у Continue и Qwen', () => {
    expect(ruleFormat('cursor-mdc').extension).toBe('.mdc');
    expect(ruleFormat('continue-md').extension).toBe('.md');
    expect(ruleFormat('qwen-md').extension).toBe('.md');
  });

  it('у Qwen свои подписи шаблонов и нет alwaysApply; прочие ключи общие', () => {
    const qwen = ruleFormat('qwen-md');
    expect(qwen.alwaysApply).toBe(false);
    expect(qwen.text('fieldGlobs')).toBe('providerRules.qwenMd.fieldGlobs');
    expect(qwen.text('fieldBody')).toBe('providerRules.fieldBody');
    expect(ruleFormat('cursor-mdc').text('fieldGlobs')).toBe('providerRules.fieldGlobs');
  });
});

describe('appliesAlways', () => {
  it('у Cursor — флаг alwaysApply, у Qwen — отсутствие шаблонов', () => {
    expect(appliesAlways(ruleFormat('cursor-mdc'), { globs: '' })).toBe(false);
    expect(appliesAlways(ruleFormat('cursor-mdc'), { alwaysApply: true, globs: 'a' })).toBe(true);
    expect(appliesAlways(ruleFormat('qwen-md'), {})).toBe(true);
    expect(appliesAlways(ruleFormat('qwen-md'), { globs: 'src/**' })).toBe(false);
  });
});
