import type { RowType } from './rowWords.types';
import { rowType } from './rowType';
import { skillSource } from './stepSource';
import type { SourceContext } from './stepSource.types';

/**
 * Вид блока скилла — по самому скиллу. Первой строкой блока бывает свой шаг
 * (вставленный сразу после стадии работы), и вид по ней давал «промпт».
 */
export function skillBlockType(skillId: string, context: SourceContext): RowType {
  return rowType(skillSource(skillId, context));
}
