// nvm-use-guard — on Windows `nvm use|on|off` (nvm-windows) first deletes the junction NVM_SYMLINK
// (e.g. C:\nvm4w\nodejs) and only then asks for elevation to make a new one. An agent shell cannot answer
// UAC, and nvm 1.2.2 breaks on the space in `C:\Program Files\nvm` anyway, so the junction stays gone:
// every shell on the machine — parallel sessions included — silently falls back to whatever other Node is
// on PATH (a standalone install in `C:\Program Files\nodejs`, or none). 26.10: a machine's default Node 22
// was lost this way twice in a day (parallel groups ran their gates on v24, re-ran them on 22, two denied
// turns and ~7 min each).
//
// The machine default is the Node behind that junction; a different version for one command is a PATH
// prefix in that shell, never a global switch under other running sessions. Only Windows with
// NVM_SYMLINK set: elsewhere `nvm use` (nvm-sh) changes the current shell only and is harmless.

const NVM_SWITCH = /(?:^|[\s;&|(])nvm(?:\.exe)?\s+(use|on|off)\b/i;

const unquoted = (command) => command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""');

/** `C:\Program Files\nvm` → `/c/Program Files/nvm` for a Git Bash PATH prefix. */
export const posixDir = (win) =>
  String(win)
    .replace(/^([A-Za-z]):[\\/]/, (_, d) => `/${d.toLowerCase()}/`)
    .replace(/\\/g, '/')
    .replace(/\/$/, '');

/** The one-command PATH prefix in the calling shell's own syntax. */
function recipe(tool, nvmHome) {
  if (tool === 'PowerShell') {
    const home = String(nvmHome || 'C:\\Program Files\\nvm').replace(/[\\/]$/, '');
    return (
      `\`$env:Path = "${home}\\v<version>;$env:Path"; node -v; <command>\` ` +
      `(installed: \`Get-ChildItem "${home}"\`)`
    );
  }
  const home = nvmHome ? posixDir(nvmHome) : '/c/Program Files/nvm';
  return `\`export PATH="${home}/v<version>:$PATH"; node -v; <command>\` (installed: \`ls "${home}"\`)`;
}

export default function nvmUseGuard(input, env = process.env, platform = process.platform) {
  if (platform !== 'win32' || !env.NVM_SYMLINK) return null;
  const tool = String(input?.tool_name ?? '');
  if (!/^(?:Bash|PowerShell)$/.test(tool)) return null;
  const m = NVM_SWITCH.exec(unquoted(String(input?.tool_input?.command ?? '')));
  if (!m) return null;
  return {
    decision: 'deny',
    reason:
      `[nvm-use-guard] \`nvm ${m[1].toLowerCase()}\` deletes the junction ${env.NVM_SYMLINK} and cannot recreate it ` +
      'without elevation — every shell on this machine then drops to whatever other Node is on PATH, or to none. ' +
      'The default Node is already the one the junction points at (`node -v`). Another installed version for ' +
      `this command only: ${recipe(tool, env.NVM_HOME)}.`,
  };
}
