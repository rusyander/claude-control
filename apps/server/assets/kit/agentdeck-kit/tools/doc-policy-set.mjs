// Record a per-project doc-hygiene decision. Run when the user answers a layout/language question
// so the same question is never asked twice.
//
//   node <kit>/tools/doc-policy-set.mjs <project-dir> off              hands off entirely
//   node <kit>/tools/doc-policy-set.mjs <project-dir> strict           back to the default
//   node <kit>/tools/doc-policy-set.mjs <project-dir> keep docs/ai ai  strict, but these dirs
//                                                                         are approved agent-doc homes
//   node <kit>/tools/doc-policy-set.mjs --list
import {
  projectRoot,
  readPolicyStore,
  writePolicyStore,
  norm,
  POLICY_STORE_PATH,
} from '../hooks/lib/doc-policy.mjs';

const [, , rawDir, rawMode, ...rest] = process.argv;

if (rawDir === '--list' || !rawDir) {
  const store = readPolicyStore();
  const rows = Object.entries(store.projects);
  if (!rows.length) console.log('no exceptions: the strict layout applies in every project');
  for (const [dir, rec] of rows) {
    console.log(
      `${dir} — mode=${rec.mode}${rec.extraRoots?.length ? ' extraRoots=' + rec.extraRoots.join(',') : ''}${rec.note ? ' // ' + rec.note : ''}`,
    );
  }
  console.log(`\nstore: ${POLICY_STORE_PATH}`);
  process.exit(0);
}

// Any unrecognised argument refuses WITHOUT writing: `--help` was once taken as a dir and a typo'd
// mode fell through to `strict`, silently deleting a project's entry.
const USAGE = 'usage: doc-policy-set.mjs <project-dir> off|strict|keep <dir...> | --list';
if (rawDir === '--help' || rawDir === '-h') {
  console.log(USAGE);
  process.exit(0);
}
if (rawDir.startsWith('-')) {
  console.error(`unknown flag ${rawDir}\n${USAGE}`);
  process.exit(2);
}
if (!['off', 'strict', 'keep'].includes(rawMode)) {
  console.error(`${rawMode ? `unknown mode «${rawMode}»` : 'no mode given'}\n${USAGE}`);
  process.exit(2);
}
if (rawMode === 'keep' && !rest.some(Boolean)) {
  console.error(`keep without directories\n${USAGE}`);
  process.exit(2);
}
if (rawMode !== 'keep' && rest.length) {
  console.error(`extra arguments: ${rest.join(' ')}\n${USAGE}`);
  process.exit(2);
}

const root = projectRoot(rawDir) || norm(rawDir);
const mode = rawMode === 'off' ? 'off' : 'strict';
const extraRoots = rawMode === 'keep' ? rest.filter(Boolean) : [];

const store = readPolicyStore();
const key = root.toLowerCase();
if (mode === 'strict' && !extraRoots.length) delete store.projects[key];
else store.projects[key] = { mode, extraRoots, since: new Date().toISOString().slice(0, 10) };

if (!writePolicyStore(store)) {
  console.error('could not write the policy store');
  process.exit(1);
}
console.log(
  `${root} → mode=${mode}${extraRoots.length ? ' extraRoots=' + extraRoots.join(',') : ''}`,
);
