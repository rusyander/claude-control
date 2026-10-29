import { describe, expect, it } from 'vitest';
import * as hiddenLaunch from './hidden-launch.ts';

/**
 * Скрытая консоль PowerShell как способ запуска серверов ушла: сервер модели, заглушка и хост
 * пересылки идут хранителем (`kept-launch`, WMI-разрыв задания). От модуля остались только
 * кавычки PowerShell и кодирование скрипта, которыми пользуется `detached-launch` (F-89).
 */
describe('hidden-launch surface: only the PowerShell quoting the detached launch uses', () => {
  it('exports psQuote and encodePowerShell, and no launcher of its own', () => {
    expect(Object.keys(hiddenLaunch).sort()).toEqual(['encodePowerShell', 'psQuote']);
  });
});
