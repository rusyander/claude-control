import { afterEach, describe, expect, it } from 'vitest';
import { e2eReportPath } from './e2e-run.ts';

/**
 * Каталог отчёта прогона по проекту. На Windows `C:\work\App` и `c:\work\app` —
 * один проект и один отчёт; на Linux `/work/App` и `/work/app` — два проекта, и
 * общий отчёт подсунул бы одному результаты прогона другого.
 */
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

const onPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};

afterEach(() => {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
});

describe('e2eReportPath — регистр пути проекта', () => {
  it('Linux: проекты, отличные регистром, — разные отчёты', () => {
    onPlatform('linux');

    expect(e2eReportPath('/data', '/work/App')).not.toBe(e2eReportPath('/data', '/work/app'));
  });

  it('Windows: одно написание в другом регистре — тот же отчёт', () => {
    onPlatform('win32');

    expect(e2eReportPath('/data', 'C:\\work\\App')).toBe(e2eReportPath('/data', 'c:\\work\\app'));
  });
});
