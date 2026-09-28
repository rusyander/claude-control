import { describe, expect, it } from 'vitest';
import { changedMemberLabel } from './changedMembers';

const word = (kind: string): string =>
  ({ skill: 'скилл', hook: 'хук', rule: 'правило' })[kind] ?? kind;

describe('changedMemberLabel: изменившийся участник пары словами', () => {
  it('вид словом интерфейса, а не ключ «skill:…»', () => {
    expect(changedMemberLabel('skill:ticket-delivery', word)).toBe('скилл ticket-delivery');
  });

  it('у хука — событие без хэша содержимого', () => {
    expect(changedMemberLabel('hook:PostToolUse:1a2b3c4d', word)).toBe('хук PostToolUse');
  });

  it('ключ без вида остаётся как есть', () => {
    expect(changedMemberLabel('ticket-delivery', word)).toBe('ticket-delivery');
  });
});
