/**
 * Требования (02 §Requirements, зона C этапа 4): судья `decideRequirements` (P01), суд записи
 * `evidenceProblem` (P92), извлечение с id ядра (G3 G4), входы судьи из журнала и факты после шага.
 */
export type * from './requirements.types.ts';
export { decideRequirements } from './decide.ts';
export { evidenceProblem } from './evidence.ts';
export { applyExtraction, extractionPlan, type ExtractionPlan } from './extraction.ts';
export { citedEvidence, requirementsInputOf, type JudgedInput } from './journal-view.ts';
export { postStepFacts, type PostStepDeps, type PostStepFacts } from './facts.ts';
