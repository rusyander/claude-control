import { describe, expect, it } from 'vitest';
import { foreignAgentName } from './runAgent';

describe('foreignAgentName — подпись CLI агента в истории прогонов', () => {
  it('Claude Code и старые записи без поля — без подписи', () => {
    expect(foreignAgentName(undefined)).toBeUndefined();
    expect(foreignAgentName('claude')).toBeUndefined();
  });

  it('чужой CLI — его имя; незнакомый id — как есть', () => {
    expect(foreignAgentName('qwen')).toBe('Qwen Code');
    expect(foreignAgentName('codex')).toBe('Codex');
    expect(foreignAgentName('gemini')).toBe('gemini');
  });
});
