import { describe, expect, it } from 'vitest';
import { draftFrom, draftToSave, sameAutomation } from './automationDraft';

describe('automationDraft', () => {
  it('рецепт в поля и обратно — та же команда', () => {
    const recipe = {
      command: 'cd api && mvn -B -fae test',
      report: 'api/target/surefire-reports/',
      timeoutMinutes: 30,
    };
    const draft = draftFrom(recipe);
    expect(draft).toEqual({
      command: 'cd api && mvn -B -fae test',
      report: 'api/target/surefire-reports/',
      format: 'junit',
      timeout: '30',
    });
    expect(draftToSave(draft)).toEqual(recipe);
    expect(sameAutomation(draft, recipe)).toBe(true);
  });

  it('пустой отчёт и junit не пишутся; негодный потолок — без потолка', () => {
    expect(
      draftToSave({ command: '  go test ./...  ', report: ' ', format: 'junit', timeout: 'абв' }),
    ).toEqual({ command: 'go test ./...' });
    expect(draftToSave({ command: 'x', report: '', format: 'junit', timeout: '0' })).toEqual({
      command: 'x',
    });
    expect(
      draftToSave({ command: 'x', report: '', format: 'cargo-test', timeout: '12.6' }),
    ).toEqual({ command: 'x', format: 'cargo-test', timeoutMinutes: 13 });
  });

  it('изменён вид отчёта или потолок — правка есть; новой команды без записи — тоже', () => {
    const saved = {
      command: 'go test -json {packages} > {report}',
      format: 'go-test-json' as const,
    };
    expect(sameAutomation({ ...draftFrom(saved), format: 'junit' }, saved)).toBe(false);
    expect(sameAutomation({ ...draftFrom(saved), timeout: '5' }, saved)).toBe(false);
    expect(sameAutomation(draftFrom(undefined), undefined)).toBe(true);
    expect(sameAutomation({ ...draftFrom(undefined), command: 'npm test' }, undefined)).toBe(false);
  });
});
