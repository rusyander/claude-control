import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import type { GlobalLayerRow, GlobalLayerTransferRequest } from '@agentdeck/contracts';
import type { PairEntry } from './registry.ts';

/**
 * Задание чату переноса. Перенос — перевод (TS ↔ `.mjs`), а не копия, поэтому
 * его делает агент, а приёмка у него та же, что у карточки: корпус зелёный на
 * обеих сторонах (`cli.ts`). В глобальный слой агент НЕ пишет: он кладёт файлы
 * в каталог предложения, а записывает их панель после того, как человек увидел
 * дифф (`service.apply`). Текст английский — его читает модель.
 */

interface TransferInput {
  pair: PairEntry;
  request: GlobalLayerTransferRequest;
  rows: readonly GlobalLayerRow[];
  configRoot: string;
  repoRoot: string;
  proposalDir: string;
  corpus: URL;
}

const slash = (path: string): string => path.replace(/\\/g, '/');

function divergenceLines(rows: readonly GlobalLayerRow[], sieve: string | undefined): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    if (sieve && row.sieve !== sieve) continue;
    const wrong = row.cases.filter((item) => item.outcome !== 'both');
    if (wrong.length === 0) continue;
    lines.push(`- ${row.sieve} — better: ${row.verdict}`);
    for (const item of wrong) {
      const side = (name: string, miss?: { missed: string[]; extra: string[] }) =>
        miss ? ` ${name} missed [${miss.missed.join(', ')}] extra [${miss.extra.join(', ')}];` : '';
      lines.push(
        `  - ${item.caseId} (${item.title.en}):${side('panel', item.panel)}${side('global', item.global)}`,
      );
    }
  }
  return lines;
}

export function transferPrompt(input: TransferInput): string {
  const { pair, request, configRoot, repoRoot, proposalDir } = input;
  const toGlobal = request.direction === 'toGlobal';
  const scope = request.sieve ? `sieve \`${request.sieve}\`` : 'every diverging sieve';
  const corpus = slash(relative(repoRoot, fileURLToPath(input.corpus)));
  const cli = `node --experimental-strip-types apps/server/src/domains/global-layer/cli.ts ${pair.id}`;
  const divergences = divergenceLines(input.rows, request.sieve);
  const globalFiles = pair.global.files.map((file) => `  - ${slash(join(configRoot, file))}`);
  const panelFiles = pair.panel.files.map((file) => `  - ${file}`);

  return [
    `Port the ${toGlobal ? 'panel' : 'global layer'}'s better behaviour into the ${
      toGlobal ? 'global layer (~/.claude)' : 'panel'
    } for pair "${pair.id}", ${scope}.`,
    '',
    `Divergences on the shared corpus \`${corpus}\` (judged by behaviour, not text):`,
    ...(divergences.length > 0 ? divergences : ['- none recorded — run the comparison first']),
    '',
    'Files:',
    `- panel (this repo, TypeScript):`,
    ...panelFiles,
    `- global layer (plain node .mjs, no build step) — READ ONLY for you:`,
    ...globalFiles,
    '',
    'Rules:',
    "- A port is a translation, not a copy: keep each side's idiom, structure and comment language.",
    toGlobal
      ? `- Do NOT edit anything under ${slash(configRoot)}. Write every changed global file, whole, to ${slash(proposalDir)}/<the same relative path> (e.g. ${slash(join(proposalDir, pair.global.module))}). The panel shows the human the diff and writes it with a backup after they confirm.`
      : '- Edit the panel files in this working copy. Do not commit.',
    `- A divergence you find that the corpus does not cover → add a case to \`${corpus}\` with the correct expectation, in the same pass.`,
    '',
    'Acceptance (all must pass before you report done):',
    `- \`${cli}${toGlobal ? ` --proposal ${slash(proposalDir)}` : ''}\` exits 0 — the corpus is green on BOTH sides.`,
    `- Panel tests: \`pnpm --filter server exec vitest run ${pair.panel.tests.join(' ')}\`.`,
    `- Global tests: ${pair.global.tests
      .map((test) => `\`node ${slash(join(configRoot, test))}\``)
      .join(
        ', ',
      )}${toGlobal ? ' — run them on a temporary copy of the global files with your proposal laid over it, never on the live layer' : ''}.`,
    '',
    'Report: which cases turned green, which corpus cases you added, and the acceptance output lines.',
  ].join('\n');
}
