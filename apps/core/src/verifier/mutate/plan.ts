import type { MutantPlanRow } from '@agentdeck/contracts/core/records';
import { z } from 'zod';
import { MutateRefusal } from './mutate.types.ts';

/**
 * План мутантов — строгая схема (P45): лишнее поле — опечатка автора плана, а не «молча проигнорировать».
 * Пустой `find` подменил бы начало файла — отказ, как и пустые имена теста и файла.
 */
const rowSchema = z
  .object({
    file: z.string().min(1),
    find: z.string().min(1),
    replace: z.string(),
    test: z.string().min(1),
    spec: z.string().min(1),
  })
  .strict();

export const mutantPlanSchema = z.array(rowSchema).min(1);

export function parsePlan(text: string, source: string): MutantPlanRow[] {
  let json: unknown;
  try {
    // План из PowerShell `Out-File` начинается с BOM — JSON.parse на нём падает.
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new MutateRefusal(`mutate: план ${source} — не JSON: ${(error as Error).message}`);
  }
  const parsed = mutantPlanSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new MutateRefusal(
      `mutate: план ${source} не по формату [{file, find, replace, test, spec}]: ${first?.path.join('.') ?? ''} ${first?.message ?? ''}`.trim(),
    );
  }
  return parsed.data;
}
