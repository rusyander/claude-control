import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { builtinKitDir } from './service.ts';

/**
 * На Windows `nvm use|on|off` (nvm-windows) сначала удаляет общий для машины переход NVM_SYMLINK и
 * только потом просит повышения прав, чтобы создать новый; оболочка агента UAC не ответит — переход
 * пропадает, и все оболочки машины, параллельные сессии тоже, молча падают на другой Node из PATH
 * (26.10 — дважды за день, гейты групп прошли не на той версии). Набор отказывает и даёт префикс PATH
 * на одну команду. Путь настоящий: диспетчер набора `run.mjs pre` отдельным процессом; страж читает
 * платформу самого процесса, поэтому на Linux и macOS проверяется молчание.
 */
const DISPATCH = join(builtinKitDir(), 'hooks', 'lib', 'run.mjs');
const NVM = { NVM_HOME: 'C:\\Program Files\\nvm', NVM_SYMLINK: 'C:\\nvm4w\\nodejs' };

function reason(tool_name: string, command: string, nvm: Record<string, string> = NVM): string {
  const { NVM_HOME: _home, NVM_SYMLINK: _link, ...env } = process.env;
  const out = spawnSync(process.execPath, [DISPATCH, 'pre'], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name,
      tool_input: { command },
      session_id: 'kit-nvm-use',
    }),
    encoding: 'utf8',
    env: { ...env, ...nvm, AGENTDECK_STEP_KIND: '', AGENTDECK_KIT_VARIANT: '' },
    timeout: 15_000,
  });
  const text = out.stdout.trim();
  if (!text) return '';
  const hook = (
    JSON.parse(text) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    }
  ).hookSpecificOutput;
  return hook?.permissionDecision === 'deny' ? (hook.permissionDecisionReason ?? '') : '';
}

const WIN = process.platform === 'win32';

describe('nvm-use-guard набора', () => {
  it.runIf(WIN)(
    'Windows с nvm-windows: переключение — отказ с префиксом PATH своей оболочки',
    () => {
      for (const command of [
        'nvm use 22.23.2',
        'cd app && nvm use',
        'nvm.exe use 20',
        'nvm on',
        'nvm off',
      ]) {
        const why = reason('Bash', command);
        expect(why, command).toContain('nvm-use-guard');
        expect(why, command).toContain('C:\\nvm4w\\nodejs');
      }
      expect(reason('Bash', 'nvm use 20')).toContain(
        'export PATH="/c/Program Files/nvm/v<version>:$PATH"',
      );
      const ps = reason('PowerShell', 'nvm use 20');
      expect(ps).toContain('$env:Path = "C:\\Program Files\\nvm\\v<version>;$env:Path"');
      expect(ps).not.toContain('export PATH');
    },
  );

  it.runIf(WIN)('чтение nvm, установка, префикс PATH и текст о nvm use — свободны', () => {
    for (const command of [
      'nvm ls',
      'nvm current',
      'nvm install 22.22.2',
      'export PATH="/c/Program Files/nvm/v22.23.2:$PATH"; node -v',
      'grep -rn "nvm use" docs',
    ])
      expect(reason('Bash', command), command).not.toContain('nvm-use-guard');
  });

  it('без nvm-windows (нет NVM_SYMLINK) и вне Windows — молчит', () => {
    expect(reason('Bash', 'nvm use 22', {})).not.toContain('nvm-use-guard');
    if (!WIN) expect(reason('Bash', 'nvm use 22')).not.toContain('nvm-use-guard');
  });
});
