import {
  randomBytes,
  scryptSync,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Шифрование резервных копий файла секретов `.mcp-secrets.env`.
 *
 * Копии складываются перед каждой записью, и по умолчанию файл секретов лежит
 * в каталоге копий открытым текстом — рядом с токенами. Когда пользователь
 * включает шифрование, копия этого файла пишется зашифрованной: расшифровать
 * её без парольной фразы нельзя.
 *
 * Только node:crypto, без новых зависимостей:
 *   • ключ выводится из ПАРОЛЬНОЙ ФРАЗЫ через scrypt (KDF, стойкий к перебору);
 *   • содержимое шифруется AES-256-GCM (шифр + встроенная проверка целостности);
 *   • соль, вектор инициализации и тег аутентификации кладутся рядом с
 *     шифротекстом в один самоописывающийся блок — чтобы расшифровать, нужен
 *     только он и парольная фраза.
 *
 * Парольная фраза НИГДЕ не хранится: ключ выводится заново при каждой операции.
 * В state.json хранится лишь verifier — производная, по которой можно проверить,
 * та ли фраза введена, но восстановить саму фразу по ней нельзя.
 */

/** Метка формата в начале блока: по ней отличаем зашифрованную копию от обычной. */
const MAGIC = Buffer.from('CCSB1\n', 'utf8');

/** Длины полей заголовка (байты). GCM: соль для scrypt, iv 96 бит, тег 128 бит. */
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32; // AES-256

/**
 * Параметры scrypt. N=2^15 — заметная стоимость перебора при незаметной задержке
 * на одной операции; храним рядом с производной, чтобы будущее ужесточение не
 * ломало разбор уже созданных копий.
 */
const SCRYPT_COST = 32_768;
const SCRYPT_BLOCK = 8;
const SCRYPT_PARALLEL = 1;
// scrypt требует maxmem ≥ 128*N*r; на дефолтных 32 МиБ N=32768 не проходит.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK,
    p: SCRYPT_PARALLEL,
    maxmem: SCRYPT_MAXMEM,
  });
}

/**
 * Зашифровать текст парольной фразой. Возвращает самодостаточный блок:
 * `MAGIC | salt | iv | tag | ciphertext`. Каждая копия получает свою соль и iv,
 * поэтому одинаковый исходник даёт разный шифротекст.
 */
export function encryptSecret(plaintext: string, passphrase: string): Buffer {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([MAGIC, salt, iv, tag, ciphertext]);
}

/** Похож ли блок на нашу зашифрованную копию — по метке формата в начале. */
export function isEncryptedBackup(blob: Buffer): boolean {
  return blob.length >= MAGIC.length && blob.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * Расшифровать блок парольной фразой. Неверная фраза (или повреждённый блок)
 * проваливает проверку тега GCM — тогда бросаем понятную ошибку, а не отдаём
 * мусор. Блок без нашей метки формата считается не зашифрованным нами.
 */
export function decryptSecret(blob: Buffer, passphrase: string): string {
  if (!isEncryptedBackup(blob)) {
    throw new Error('Это не зашифрованная копия');
  }

  let offset = MAGIC.length;
  const salt = blob.subarray(offset, (offset += SALT_LEN));
  const iv = blob.subarray(offset, (offset += IV_LEN));
  const tag = blob.subarray(offset, (offset += TAG_LEN));
  const ciphertext = blob.subarray(offset);

  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // GCM не сошёлся: либо парольная фраза не та, либо копия повреждена.
    throw new Error('Неверная парольная фраза или повреждённая копия');
  }
}

/**
 * Verifier парольной фразы для хранения в state.json. Это `salt:hash` (hex),
 * где hash = scrypt(фраза, salt). По нему проверяется, та ли фраза введена, но
 * саму фразу восстановить нельзя. Своя соль — чтобы verifier не совпадал с
 * ключами шифрования и одинаковые фразы у разных людей давали разные verifier.
 */
export function makeVerifier(passphrase: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = deriveKey(passphrase, salt);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Совпадает ли парольная фраза с сохранённым verifier. Сравнение в постоянное
 * время — чтобы по времени ответа нельзя было подбирать фразу. Кривой verifier
 * (не того формата) — это «не совпало», а не исключение.
 */
export function verifyPassphrase(passphrase: string, verifier: string): boolean {
  const [saltHex, hashHex] = verifier.split(':');
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== KEY_LEN) return false;

  const actual = deriveKey(passphrase, salt);
  return timingSafeEqual(actual, expected);
}
