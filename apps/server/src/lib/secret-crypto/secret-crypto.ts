import { isKeysError } from '@agentdeck/keys/errors';
import { decryptSecret as decryptCoded } from '@agentdeck/keys/secret-crypto';
import { coded } from '../server-text/server-text.ts';

/**
 * Фасад старого пути: шифрование переехало в `packages/keys` (общее для панели, ядра и хоста
 * переходов, план s5 G12). Пакет бросает ошибки с кодом и английским текстом; панель
 * показывает человеку свои русские — здесь код переводится обратно ровно в прежние тексты,
 * чтобы ни один вызывающий и ни один тест старого пути не заметил переезда.
 */

export {
  encryptSecret,
  isEncryptedBackup,
  makeVerifier,
  verifyPassphrase,
} from '@agentdeck/keys/secret-crypto';

export function decryptSecret(blob: Buffer, passphrase: string): string {
  try {
    return decryptCoded(blob, passphrase);
  } catch (error) {
    if (isKeysError(error) && error.code === 'not-encrypted') {
      throw coded(
        new Error('Это не зашифрованная копия', { cause: error }),
        'backup-not-encrypted',
      );
    }
    // GCM не сошёлся: либо парольная фраза не та, либо копия повреждена.
    throw new Error('Неверная парольная фраза или повреждённая копия', { cause: error });
  }
}
