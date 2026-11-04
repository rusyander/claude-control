import { qwenRunFacts } from '@agentdeck/providers/qwen';
import { qwenPathPattern } from '../../../qwen/permission.ts';
import { createQwenAdapter, QWEN_CHANNELS } from '../../../qwen/qwen.ts';
import type { Profile } from './profile.types.ts';
import { ENDPOINT } from './shared.ts';

const A = '11111111-1111-4111-8111-111111111111';

export const QWEN_PROFILE: Profile = {
  id: qwenRunFacts.id,
  // Подставной CLI хуков не исполняет: сеанс без хука ядра — только с явным флагом тестов (F-10).
  make: (options) => createQwenAdapter({ ...options, unhookedForTests: true }),
  command: qwenRunFacts.binary.command,
  endpoint: {
    channel: QWEN_CHANNELS.find((c) => c.dialect === 'openai-chat')!,
    endpoint: { ...ENDPOINT, dialect: 'openai-chat' },
  },
  fixtures: {
    basic: 'basic',
    resume: { name: 'resume', cmdId: A },
    missing: { exit: 1, stderr: 'No saved session found with ID 33333333' },
    deny: 'readdeny',
    refused: 'shell',
    permitAllow: 'permit-core-allow',
    permitDeny: 'permit-core-deny',
  },
  settings: 'qwen/system-settings.json',
  brief: (argv) =>
    (argv.find((a) => a.startsWith('--append-system-prompt=')) ?? '').slice(
      '--append-system-prompt='.length,
    ),
  denyRules: (s) => (s.permissions as { deny: string[] }).deny,
  mcpNames: (argv) => {
    const at = argv.indexOf('--allowed-mcp-server-names');
    const out: string[] = [];
    for (let i = at + 1; i < argv.length && !argv[i]!.startsWith('--'); i += 1) {
      if (argv[i]) out.push(argv[i]!);
    }
    return out;
  },
  hookCommands: (s) =>
    (
      (s.hooks as { PreToolUse?: { hooks: { command: string }[] }[] } | undefined)?.PreToolUse ?? []
    ).flatMap((g) => g.hooks.map((h) => h.command)),
  shellRule: (argv) => `run_shell_command(${argv.join(' ')}:*)`,
  pathRule: (cwd, path, op) =>
    `${op === 'read' ? 'read_file' : 'edit'}(${qwenPathPattern(cwd, path)})`,
  permitRoad: 'in-band',
};
