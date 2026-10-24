import { describe, expect, it } from 'vitest';
import { POWERSHELL_ONLY_ASK, withPowerShellTwins } from './powershell-twins.ts';

describe('withPowerShellTwins', () => {
  it('к каждому `Bash(…)` — такое же `PowerShell(…)`, прочие правила как есть', () => {
    expect(withPowerShellTwins(['Bash(git *)', 'mcp__gitlab', 'Bash(*git*push*:**)'])).toEqual([
      'Bash(git *)',
      'mcp__gitlab',
      'Bash(*git*push*:**)',
      'PowerShell(git *)',
      'PowerShell(*git*push*:**)',
    ]);
  });

  it('без повторов, если близнец уже есть', () => {
    expect(withPowerShellTwins(['Bash(rm *)', 'PowerShell(rm *)'])).toEqual([
      'Bash(rm *)',
      'PowerShell(rm *)',
    ]);
  });

  it('свои правила PowerShell — только форма правила CLI', () => {
    for (const rule of POWERSHELL_ONLY_ASK) expect(rule).toMatch(/^PowerShell\([^()]+\)$/);
  });
});
