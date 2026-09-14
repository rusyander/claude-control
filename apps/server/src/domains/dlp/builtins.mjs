/**
 * Встроенные образцы защиты данных — ОДНА копия на прокси, шлюз контура и хук.
 *
 * Обычный `.mjs` без импортов намеренно: хук промпта исполняет Claude Code, а не
 * панель, и текст этого файла вставляется в сгенерированный скрипт целиком
 * (`../prompt-gate/script.ts`). До 15.09.2026 образцы жили двумя копиями —
 * здесь, в `rules.ts`, и в ядре хука; каждый новый образец пришлось бы писать
 * дважды, и первая же забытая копия пропускала бы данные мимо одной из дверей.
 *
 * Принцип отбора прежний: ложное срабатывание хуже пропуска. Выражение широкое,
 * отсев делает `validate` — контрольная сумма там, где она у формата есть
 * (ИНН, СНИЛС, карта, IBAN, ОГРН), и отказ от значений, которые ничего не
 * выдают (loopback, нулевой UUID), там, где суммы нет.
 */

/** Порядок — тот, в котором образцы показывает раздел «Защита данных». */
export const DLP_BUILTIN_IDS = [
  'email',
  'phone_ru',
  'phone_intl',
  'inn',
  'snils',
  'ogrn',
  'passport_ru',
  'passport_ru_foreign',
  'passport_uz',
  'card',
  'iban',
  'crypto_wallet',
  'ipv4',
  'ipv6',
  'mac',
  'uuid',
  'url',
  'credentials_url',
  'jwt',
  'secret_key',
];

export const DLP_BUILTINS = {
  email: { source: String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+` },
  // Российский номер в бытовых написаниях: +7, 8, скобки, дефисы, пробелы.
  phone_ru: { source: String.raw`(?:\+7|8)[ \-(]*\d{3}[ \-)]*\d{3}[ \-]?\d{2}[ \-]?\d{2}` },
  // Любой номер с кодом страны. +7 оставлен образцу выше: одна строка под двумя
  // правилами получила бы метку того, что короче или левее, то есть случайную.
  phone_intl: {
    source: String.raw`(?<![\w+])\+\d{1,3}(?:[ \-]?\(\d{1,4}\)|[ \-]?\d{1,4}){2,5}(?!\d)`,
    validate: isValidIntlPhone,
  },
  inn: { source: String.raw`\b\d{10}\b|\b\d{12}\b`, validate: isValidInn },
  snils: { source: String.raw`\b\d{3}[- ]?\d{3}[- ]?\d{3}[- ]?\d{2}\b`, validate: isValidSnils },
  ogrn: { source: String.raw`(?<!\d)(?:[15]\d{12}|3\d{14})(?!\d)`, validate: isValidOgrn },
  // Паспорт РФ — только в формах, которые не спутать с числами из текста: серия
  // с пробелом внутри («45 06 123456»), знак номера («4506 №123456») или слово
  // «паспорт»/«серия» рядом. Голое «2026 123456» — это и сумма, и год с номером
  // заказа: серия «20 26» у паспорта существует, различить их нечем.
  passport_ru: {
    source: String.raw`(?<![\d.,])(?:\d{2} \d{2} (?:№ ?)?\d{6}|\d{4} ?№ ?\d{6}|(?<=(?:[Пп]аспорт|[Сс]ери[яи]|[Pp]assport)[^\d\n]{0,24})\d{4} \d{6})(?![\d.,])`,
    validate: (value) => !value.startsWith('00'),
  },
  // Заграничный: девять цифр без контрольной суммы, поэтому тоже только со знаком
  // номера или словом рядом — «10 1234567» в тексте чаще количество и артикул.
  passport_ru_foreign: {
    source: String.raw`(?<![\d.,])(?:\d{2} ?№ ?\d{7}|(?<=(?:[Зз]агран|[Пп]аспорт|[Pp]assport)[^\d\n]{0,24})\d{2} \d{7})(?![\d.,])`,
  },
  // Две латинские буквы и семь цифр: Узбекистан и большинство паспортов той же
  // формы. Только заглавные — строчные чаще оказываются идентификатором в коде.
  passport_uz: { source: String.raw`(?<![A-Za-z\d])[A-Z]{2} ?\d{7}(?!\d)` },
  card: { source: String.raw`\b(?:\d[ -]?){12,18}\d\b`, validate: isValidCard },
  iban: {
    source: String.raw`\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b`,
    validate: isValidIban,
  },
  // bech32 и адрес Ethereum. Старый base58 биткоина без проверки sha256 не
  // отличить от хеша коммита — полтора процента хешей начинаются нужной цифрой
  // и не содержат нуля, поэтому его здесь нет.
  crypto_wallet: { source: String.raw`\bbc1[ac-hj-np-z02-9]{25,59}\b|\b0x[0-9a-fA-F]{40}\b` },
  ipv4: {
    source: String.raw`(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d|\.\d)`,
    validate: isMeaningfulIpv4,
  },
  // Хвост `\.\d` не отдаёт образцу половину смешанной записи `::ffff:192.168.1.1`:
  // иначе маска закрыла бы `::ffff:192`, а `168.1.1` ушло бы в модель как есть.
  ipv6: {
    source: String.raw`(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![\w:]|\.\d)`,
    validate: isValidIpv6,
  },
  mac: {
    source: String.raw`(?<![\w:\-])[0-9A-Fa-f]{2}([:\-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}(?![\w:\-])`,
    validate: (value) => !/^(?:00[:-]){5}00$|^(?:ff[:-]){5}ff$/i.test(value),
  },
  uuid: {
    source: String.raw`(?<![0-9A-Fa-f-])[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}(?![0-9A-Fa-f-])`,
    validate: (value) => /[1-9A-Fa-f]/.test(value),
  },
  // Хвостовая точка или запятая — конец предложения, а не часть адреса.
  url: {
    source: String.raw`\b(?:https?|ftp|wss?)://[^\s"'<>\x60()\[\]{}]*[^\s"'<>\x60()\[\]{}.,;:!?]`,
  },
  // Логин и пароль внутри адреса подключения. Отдельно от ключей и маскируется, а
  // не отклоняет: `postgres://postgres:postgres@localhost` стоит в README каждого
  // второго проекта, и запрет останавливал бы работу на чтении документации.
  credentials_url: { source: String.raw`\b[a-z][a-z0-9+.\-]{1,20}://[^\s:/@]{1,64}:[^\s:/@]{3,}@` },
  jwt: { source: String.raw`\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{10,}` },
  // Ключи с опознаваемым началом: у них форма задана самим вендором, гадать не
  // приходится. Общего «длинная строка из букв и цифр» здесь нет намеренно —
  // под него попадает половина хешей и идентификаторов в любом коде.
  secret_key: {
    source: [
      String.raw`sk-[A-Za-z0-9_-]{16,}`,
      String.raw`[sr]k_(?:live|test)_[0-9A-Za-z]{16,}`,
      String.raw`gh[pousr]_[A-Za-z0-9]{20,}`,
      String.raw`github_pat_[A-Za-z0-9_]{22,}`,
      String.raw`gl(?:pat|dt|rt|ptt|cbt)-[A-Za-z0-9_-]{20,}`,
      String.raw`(?:AKIA|ASIA)[0-9A-Z]{16}`,
      String.raw`AIza[0-9A-Za-z_-]{35}`,
      String.raw`ya29\.[0-9A-Za-z_-]{20,}`,
      String.raw`xox[baprse]-[A-Za-z0-9-]{10,}`,
      String.raw`xapp-\d-[A-Za-z0-9-]{10,}`,
      String.raw`https://hooks\.slack\.com/services/[A-Za-z0-9/_-]{20,}`,
      String.raw`npm_[A-Za-z0-9]{36}`,
      String.raw`hf_[A-Za-z0-9]{30,}`,
      String.raw`SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}`,
      String.raw`(?<!\d)\d{8,10}:AA[A-Za-z0-9_-]{33}`,
      String.raw`\bBearer [A-Za-z0-9._~+/-]{24,}=*`,
      String.raw`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----`,
    ].join('|'),
  },
};

function digitsOf(value) {
  return [...value].filter((char) => char >= '0' && char <= '9').map(Number);
}

/**
 * Одни нули проходят и ИНН, и СНИЛС (сумма ноль, контроль ноль), а ничего не
 * выдают: это нулевой UUID, заглушка в форме и пустое поле в выгрузке.
 */
function allZero(digits) {
  return digits.every((digit) => digit === 0);
}

/**
 * ИНН: контрольные разряды считаются по опубликованным ФНС коэффициентам —
 * один для десятизначного (физлицо-ИП/организация), два для двенадцатизначного.
 */
function isValidInn(value) {
  const digits = digitsOf(value);
  if (allZero(digits)) return false;
  const check = (weights, upTo) => {
    const sum = weights.reduce((total, weight, index) => total + weight * (digits[index] ?? 0), 0);
    return (sum % 11) % 10 === (digits[upTo] ?? -1);
  };

  if (digits.length === 10) return check([2, 4, 10, 3, 5, 9, 4, 6, 8], 9);
  if (digits.length === 12) {
    return (
      check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 10) && check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8], 11)
    );
  }
  return false;
}

/**
 * СНИЛС: сумма первых девяти цифр с весами 9…1, дальше правило остатка,
 * описанное в порядке ведения ПФР (100 и 101 дают контрольное «00»).
 */
function isValidSnils(value) {
  const digits = digitsOf(value);
  if (digits.length !== 11 || allZero(digits)) return false;

  const sum = digits.slice(0, 9).reduce((total, digit, index) => total + digit * (9 - index), 0);
  const control = (digits[9] ?? 0) * 10 + (digits[10] ?? 0);

  if (sum < 100) return sum === control;
  if (sum === 100 || sum === 101) return control === 0;
  const rest = sum % 101;
  if (rest === 100) return control === 0;
  return rest === control;
}

/**
 * ОГРН (13 цифр) и ОГРНИП (15): остаток от деления на 11 и 13, последняя цифра
 * остатка — контрольная. Второй и третий разряды — год записи, и он же отсекает
 * метку времени в миллисекундах: `1726…` дала бы «72-й год», которого у реестра
 * нет (записи идут с 2002-го).
 */
function isValidOgrn(value) {
  const year = Number(value.slice(1, 3));
  if (year < 2 || year > 39) return false;
  const body = BigInt(value.slice(0, -1));
  const modulo = value.length === 13 ? 11n : 13n;
  return Number((body % modulo) % 10n) === Number(value.slice(-1));
}

/**
 * Номер карты — алгоритм Луна плюс разумная длина (13…19 цифр). Первая цифра не
 * ноль: у платёжных систем такого начала нет, а нули Луна пропускает — нулевой
 * UUID `00000000-0000-…` иначе читался двумя «картами».
 */
function isValidCard(value) {
  const digits = digitsOf(value);
  if (digits.length < 13 || digits.length > 19 || digits[0] === 0) return false;

  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits[index] ?? 0;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/** IBAN: ISO 13616 — четыре знака в конец, буквы в числа, остаток от 97 равен 1. */
function isValidIban(value) {
  const compact = value.replace(/ /g, '');
  if (compact.length < 15 || compact.length > 34) return false;
  const rotated = compact.slice(4) + compact.slice(0, 4);
  let rest = 0;
  for (const char of rotated) {
    const code = char >= 'A' && char <= 'Z' ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of code) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}

/** Код страны плюс номер: от 10 до 15 цифр по E.164, без российского +7. */
function isValidIntlPhone(value) {
  if (value.startsWith('+7')) return false;
  const count = digitsOf(value).length;
  return count >= 10 && count <= 15;
}

/**
 * Loopback, «любой адрес» и широковещательный не выдают ничего о сети человека:
 * они одинаковы на любой машине. Маска на них стоила бы понимания задачи
 * (`127.0.0.1:5178` в каждом втором файле этого проекта) и не защищала бы ничего.
 */
function isMeaningfulIpv4(value) {
  return !value.startsWith('127.') && value !== '0.0.0.0' && value !== '255.255.255.255';
}

/**
 * IPv6 по форме: не больше одного `::`, группы по 1–4 знака, всего восемь без
 * сокращения и не больше семи с ним. Цифра обязательна — иначе `dead::beef`
 * в тексте о коде; `::` и `::1` ничего не выдают, как loopback выше. Время
 * `12:30:45` отсекается тем, что без сокращения нужны все восемь групп.
 */
function isValidIpv6(value) {
  if (value === '::' || value === '::1' || !/\d/.test(value)) return false;
  const halves = value.split('::');
  if (halves.length > 2) return false;
  const groupsOf = (part) => (part === '' ? [] : part.split(':'));
  const groups = halves.flatMap(groupsOf);
  if (!groups.every((group) => /^[0-9A-Fa-f]{1,4}$/.test(group))) return false;
  return halves.length === 2 ? groups.length >= 1 && groups.length <= 7 : groups.length === 8;
}
