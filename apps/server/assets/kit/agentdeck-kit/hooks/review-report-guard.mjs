#!/usr/bin/env node
// A deep-review report keeps its work-list shape: header lines, per-finding fields, computed counts — at Write and at Stop.
// Kit hook item: run by the event dispatcher (lib/run.mjs) or on its own; see lib/items.mjs.
import reviewReportGuard, { reviewReportAtStop } from './lib/review-report.mjs';
import { runIfMain, TOOLS } from './lib/items.mjs';

export const hooks = {
  pre: { tools: TOOLS.EDIT, run: reviewReportGuard },
  stop: reviewReportAtStop,
};

await runIfMain(import.meta.url, 'review-report-guard', { hooks });
