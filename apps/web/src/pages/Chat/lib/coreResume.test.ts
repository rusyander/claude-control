import { describe, expect, it } from 'vitest';
import { coreResumeIdOf, coreResumeSearch } from './coreResume';

const ID = '0d3c2b1a-9e8f-4a7b-8c6d-5e4f3a2b1c0d';
const RUN = '11111111-2222-4333-8444-555555555555';

describe('«Продолжить через ядро»: какой разговор продолжается', () => {
  it('сеанс прогона точнее строки списка; без сеанса — сам разговор', () => {
    expect(coreResumeIdOf(RUN, ID)).toBe(RUN);
    expect(coreResumeIdOf(undefined, ID)).toBe(ID);
  });

  it('черновик и не-UUID не продолжаются: кнопки нет', () => {
    expect(coreResumeIdOf(undefined, undefined)).toBeUndefined();
    expect(coreResumeIdOf(undefined, `new-${Date.now()}`)).toBeUndefined();
    expect(coreResumeIdOf('run-7', 'new-1')).toBeUndefined();
    expect(coreResumeIdOf('not-a-uuid', ID)).toBe(ID);
  });

  it('адрес формы несёт проект, CLI Claude и id разговора', () => {
    expect(coreResumeSearch('C:/w/app', ID)).toEqual({
      project: 'C:/w/app',
      cli: 'claude',
      resume: ID,
    });
  });
});
