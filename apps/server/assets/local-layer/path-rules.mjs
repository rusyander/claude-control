#!/usr/bin/env node
// Local project layer: path-scoped rules and nested CLAUDE.md, delivered on the first touch of a
// matching file, once per session — what Claude Code itself does for `.claude/rules` with `paths`
// and for subdirectory CLAUDE.md, which `--setting-sources user,local` switches off.
// argv[2] = build/rules.json (patterns already compiled to RegExp sources by the panel).
// Same "Contents of <path>:" header the CLI uses (probe 18.10.2026, claude 2.1.286).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

// Hook output above ~10k chars is spilled to a file by the CLI; stay under it and point at the rest.
const BUDGET = 9500;

function input() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

function main() {
  const index = process.argv[2];
  if (!index || !existsSync(index)) return;
  const event = input();
  const target = event.tool_input?.file_path ?? event.tool_input?.notebook_path;
  if (typeof target !== 'string' || !target) return;
  const file = isAbsolute(target) ? target : resolve(event.cwd ?? process.cwd(), target);
  const { caseless, rules } = JSON.parse(readFileSync(index, 'utf8'));
  // Per user, closed to others: /tmp is shared on Linux, and the first user's dir would deny the
  // second one's write — rules then silently never arrive.
  const stateDir = join(
    tmpdir(),
    `agentdeck-local-layer${process.getuid ? `-${process.getuid()}` : ''}`,
  );
  const session = String(event.session_id ?? 'no-session').replace(/[^\w.-]/g, '_');
  const stateFile = join(stateDir, `${session}.json`);
  const seen = new Set(existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : []);

  const hits = rules.filter((rule) => {
    if (seen.has(rule.id)) return false;
    const rel = relative(rule.base, file).replaceAll('\\', '/');
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
    return rule.patterns.some((source) => new RegExp(source, caseless ? 'i' : '').test(rel));
  });
  if (hits.length === 0) return;

  let left = BUDGET;
  const parts = [];
  for (const rule of hits) {
    const text = existsSync(rule.file) ? readFileSync(rule.file, 'utf8') : '';
    const block = `Contents of ${rule.label}:\n\n${text}`;
    if (block.length <= left) {
      parts.push(block);
      left -= block.length;
    } else {
      parts.push(
        `Contents of ${rule.label}: too long to inline here (${text.length} chars) — read that file before working under this path.`,
      );
    }
    seen.add(rule.id);
  }
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(stateFile, JSON.stringify([...seen]), 'utf8');
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: parts.join('\n\n\n') },
    }),
  );
}

try {
  main();
} catch {
  // A broken rule index must never block the agent's tool call.
}
