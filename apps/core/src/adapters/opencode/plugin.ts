import { HOOK_JSON_FLAG } from '../hook-words.ts';

/**
 * Плагин opencode с хуком ядра (файл дома сеанса, `tool.execute.before`): каждый вызов
 * инструмента идёт в хук ядра (`run.ts hook --json`) вызовом в форме PreToolUse. Отказ плагина —
 * брошенная ошибка: opencode вызов не исполняет, текст отказа видит модель (проба 02.11 во всех
 * режимах `permission`). Fail-closed: хук не запустился, упал, ответил не той формой — отказ.
 */
export function opencodePluginSource(coreHook: string): string {
  const command = `${coreHook} ${HOOK_JSON_FLAG}`;
  return `// agentdeck: core hook plugin for opencode (generated per session)
import { spawn } from 'node:child_process';

const COMMAND = ${JSON.stringify(command)};

// Хук ядра: вызов на stdin, ответ — пустой вывод (разрешено) или JSON отказа при коде 0.
function ask(call) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(COMMAND, { shell: true, windowsHide: true, stdio: 'pipe' });
    } catch (error) {
      resolve({ deny: 'agentdeck: core hook did not start (' + String(error) + '); denied' });
      return;
    }
    child.stdout.on('data', (c) => (out += c.toString('utf8')));
    child.stderr.on('data', (c) => (err += c.toString('utf8')));
    child.on('error', (error) => resolve({ deny: 'agentdeck: core hook failed (' + error.message + '); denied' }));
    child.on('close', (code) => {
      const text = out.trim();
      if (code !== 0) {
        resolve({ deny: 'agentdeck: core hook exited ' + code + '; denied ' + err.trim() });
        return;
      }
      if (text === '') {
        resolve({ allow: true });
        return;
      }
      let reason = 'agentdeck: core hook answered without a decision; denied';
      try {
        const d = JSON.parse(text).hookSpecificOutput;
        if (d && d.permissionDecision === 'deny') reason = String(d.permissionDecisionReason || 'denied');
      } catch {}
      resolve({ deny: reason });
    });
    child.stdin.end(JSON.stringify(call));
  });
}

export const AgentdeckCoreHook = async () => ({
  'tool.execute.before': async (input, output) => {
    const got = await ask({
      hook_event_name: 'PreToolUse',
      tool_name: String(input && input.tool),
      tool_input: (output && output.args) || {},
      tool_call_id: String((input && input.callID) || ''),
    });
    if (!got.allow) throw new Error(got.deny);
  },
});
`;
}
