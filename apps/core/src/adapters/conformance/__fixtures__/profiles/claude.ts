import { readFileSync } from 'node:fs';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { CLAUDE_CHANNELS, createClaudeAdapter } from '../../../claude/claude.ts';
import { claudeAbsolutePattern } from '../../../claude/permission.ts';
import { fixturePath } from '../replay.ts';
import type { Profile } from './profile.types.ts';
import { after, ENDPOINT } from './shared.ts';

const B = '22222222-2222-4222-8222-222222222222';

export const CLAUDE_PROFILE: Profile = {
  id: claudeRunFacts.id,
  // Подставной CLI хуков не исполняет: сеанс без хука ядра — только с явным флагом тестов (F-10).
  make: (options) => createClaudeAdapter({ ...options, unhookedForTests: true }),
  command: claudeRunFacts.binary.command,
  endpoint: {
    channel: CLAUDE_CHANNELS[0]!,
    endpoint: { ...ENDPOINT, dialect: 'anthropic-messages' },
  },
  fixtures: {
    basic: 'basic',
    resume: { name: 'resume', cmdId: B },
    missing: {
      fixture: fixturePath('claude', 'missing'),
      eager: true,
      exit: 1,
      stderr: 'No conversation found with session ID: 33333333-3333-4333-8333-333333333333',
    },
    deny: 'deny',
    refused: 'permit',
    wake: 'bg-permit-allow',
    denyOverPermit: 'deny-permit-allow',
    window: 'window',
  },
  settings: 'claude/settings.json',
  brief: (argv) => readFileSync(after(argv, '--append-system-prompt-file')!, 'utf8'),
  skillsOff: (argv) => argv.includes('--disable-slash-commands'),
  denyRules: (s) => (s.permissions as { deny: string[] }).deny,
  mcpNames: (argv) =>
    Object.keys(
      (JSON.parse(readFileSync(after(argv, '--mcp-config')!, 'utf8')) as { mcpServers: object })
        .mcpServers,
    ),
  hookCommands: (s) =>
    ((s.hooks as { PreToolUse?: { hooks: { command: string }[] }[] }).PreToolUse ?? []).flatMap(
      (g) => g.hooks.map((h) => h.command),
    ),
  shellRule: (argv) => `Bash(${argv.join(' ')}:*)`,
  pathRule: (_cwd, path, op) =>
    `${op === 'read' ? 'Read' : 'Edit'}(${claudeAbsolutePattern(path)})`,
  permitRoad: 'tool',
};
