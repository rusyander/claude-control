// Silent auto-format of the edited file (PostToolUse on Write/Edit). Runs the project's own
// formatter ONLY when it is actually configured (local prettier / gofmt / ruff). Always silent
// — success and failure alike — so nothing lands in context.
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, extname, join, parse } from 'node:path';

function findUp(startDir, probe) {
  let dir = startDir;
  const { root } = parse(startDir);
  for (;;) {
    const hit = probe(dir);
    if (hit) return hit;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

const quiet = { timeout: 10000, stdio: ['ignore', 'ignore', 'ignore'] };

export default function formatOnEdit(input) {
  const filePath = String(input?.tool_input?.file_path ?? '');
  if (!filePath || !existsSync(filePath)) return null;
  const ext = extname(filePath).toLowerCase();
  try {
    if (
      [
        '.ts',
        '.tsx',
        '.js',
        '.jsx',
        '.json',
        '.css',
        '.scss',
        '.md',
        '.mjs',
        '.cjs',
        '.vue',
      ].includes(ext)
    ) {
      // Prettier's JS entry via node directly, never through a shell: shell:true quoted nothing,
      // so a path with a space silently failed and a crafted filename reached the shell line.
      const entry = findUp(dirname(filePath), (dir) => {
        for (const rel of [join('bin', 'prettier.cjs'), 'bin-prettier.js']) {
          const p = join(dir, 'node_modules', 'prettier', rel);
          if (existsSync(p)) return p;
        }
        return null;
      });
      // Only with a local prettier — it honours the project's own config/ignore. Big files pay
      // seconds per save for a convenience; leave them to the project's own format script.
      if (entry && statSync(filePath).size <= 64 * 1024)
        execFileSync(process.execPath, [entry, '--write', '--ignore-unknown', filePath], quiet);
    } else if (ext === '.go') {
      execFileSync('gofmt', ['-w', filePath], quiet);
    } else if (ext === '.py') {
      execFileSync('ruff', ['format', '--quiet', filePath], quiet);
    }
  } catch {
    /* silent: formatting is a convenience, not a gate */
  }
  return null;
}
