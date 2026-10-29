import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Fact } from '@agentdeck/contracts/core/facts';
import { createExclusive, readBytesSync } from '../../platform/safe-io/files.ts';

/**
 * Ключ подписи записей проверок — в доме ядра (04:33), не в репозитории: запись, правленная
 * руками или принесённая из чужого репозитория, не сходится с подписью и не становится зелёной.
 * Создаётся один раз (`wx`, 0600); испорченный файл не пересоздаётся — `unknown`, не новый ключ
 * (новый ключ молча обесценил бы все записи, а битый файл — повод для человека).
 */

export const VERIFY_KEY_FILE = 'verify-key';
const HEX = /^[0-9a-f]{64}$/;

function parse(bytes: Buffer, path: string): Fact<Buffer> {
  const text = bytes.toString('utf8').trim();
  if (!HEX.test(text)) return { unknown: `garbage: ${path} is not a 32-byte hex key` };
  return { value: Buffer.from(text, 'hex') };
}

export function loadVerifyKey(coreHome: string): Fact<Buffer> {
  const path = join(coreHome, VERIFY_KEY_FILE);
  const first = readBytesSync(path);
  if ('value' in first) return parse(first.value, path);
  if ('unknown' in first) return first;
  try {
    createExclusive(path, `${randomBytes(32).toString('hex')}\n`, 0o600);
  } catch (error) {
    return { unknown: `create ${path}: ${(error as Error).message}` };
  }
  // Читается то, что лежит на диске: при гонке двух ядер у обоих один ключ — первого создавшего.
  const again = readBytesSync(path);
  if ('value' in again) return parse(again.value, path);
  if ('unknown' in again) return again;
  return { unknown: `${path} vanished right after creation` };
}
