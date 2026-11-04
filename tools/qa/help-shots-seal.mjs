/**
 * Печать кадра справки: текст описи `frames.json` и байты PNG — одна пара одного снимка.
 *
 * Все сканы справки (секреты, марка, личный список) читают ТЕКСТ описи; пиксели не читает никто,
 * OCR здесь нет. Поэтому текст, поправленный руками рядом со старой картинкой, проходил их чисто:
 * platform/agent/01-chat-run нёс на картинке марку стенда и прежнее имя панели, а в описи —
 * исправленный текст (03.11.2026). Кит ставит печать (`frameSeal` в `kit.mjs`) в том же вызове,
 * что пишет картинку и текст; здесь обе половины считаются заново.
 *
 * Красное: сдвинулась картинка, текст или оба без новой печати; кадр без печати, которого нет в
 * описи долга `unsealed.json`; строка долга, указывающая на кадр, которого нет. Долг — кадры,
 * которым первое заполнение печатей не поверило (картинка переписана после снимка или текст
 * правлен при прежнем времени снимка); он печатается и не краснеет, а убывает с каждой
 * пересъёмкой — кит сам снимает кадр с долга.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SHOT_VARIANTS,
  frameSeal,
  restampFrame,
  sealDrift,
  unsealedKey,
  variantOf,
} from '../help-shots/kit.mjs';

const HOW = {
  text:
    'текст описи изменён, картинка прежняя — переснимите кадр; если картинку обработал скрипт, ' +
    'он перештамповывает её через restampFrame (kit.mjs), руками печать не ставится',
  png:
    'картинка изменилась, а текст описи снят с прежней — переснимите кадр; картинку, обработанную ' +
    'после снимка, перештамповывает её скрипт через restampFrame (kit.mjs)',
  both: 'ни картинка, ни текст не сходятся с печатью — переснимите кадр',
};

/**
 * Сверить печати каталога. `readPng(entry, file)` — байты файла или `undefined` (файла нет: это
 * называет основная проверка описи). `unsealed` — опись долга `{ files: [ключ…] }`.
 */
export function sealProblems(catalog, unsealed, readPng) {
  const problems = [];
  const debt = [];
  const listed = new Set(unsealed.files ?? []);
  const present = new Set();
  const topics = new Set(catalog.map((entry) => entry.topic));
  for (const entry of catalog) {
    if (!entry.manifest) continue;
    const where = `${entry.topic}/${entry.scenario}`;
    for (const frame of entry.manifest.frames) {
      for (const variant of SHOT_VARIANTS) {
        const taken = variantOf(frame, variant);
        if (!taken?.file) continue;
        const key = unsealedKey(entry.topic, entry.scenario, taken.file);
        present.add(key);
        const png = readPng(entry, taken.file);
        if (!png) continue;
        const name = `${where}/${frame.id} [${variant.key}]`;
        if (!taken.seal) {
          if (listed.has(key)) debt.push(key);
          else
            problems.push(
              `${name}: нет печати кадра, и в долге (unsealed.json) его нет — печать ставит только ` +
                'съёмка (kit.mjs) или restampFrame; переснимите кадр',
            );
          continue;
        }
        const drift = sealDrift(taken.seal, png, taken.text ?? '');
        if (drift !== 'ok') problems.push(`${name}: печать кадра не сходится — ${HOW[drift]}`);
      }
    }
  }
  for (const key of listed) {
    if (topics.has(key.split('/')[0]) && !present.has(key))
      problems.push(`${key}: в долге без печати (unsealed.json) числится кадр, которого нет`);
  }
  return { problems, debt };
}

/** Строка отчёта о долге: сколько кадров ещё без печати и в каких разделах. */
export function debtLine(debt) {
  if (debt.length === 0) return 'Кадров без печати: 0';
  const byTopic = new Map();
  for (const key of debt) {
    const topic = key.split('/')[0];
    byTopic.set(topic, (byTopic.get(topic) ?? 0) + 1);
  }
  const parts = [...byTopic].map(([topic, count]) => `${topic} ${count}`).join(', ');
  return `Кадров без печати (долг первого заполнения, снимается пересъёмкой): ${debt.length} — ${parts}`;
}

/**
 * Самопроверка печати: каждая сдвинутая половина краснеет, верная пара и кадр в долге молчат,
 * а `restampFrame` ставит печать по байтам на диске и отказывает, если нарисованного нет в тексте.
 */
export function selftestSeal() {
  let failed = 0;
  const check = (what, ok) => {
    console.log(`${ok ? 'ок   ' : 'ПЛОХО'} печать: ${what}`);
    if (!ok) failed += 1;
  };
  const png = Buffer.from('PNG-кадр-первый');
  const text = 'Чат AgentDeck Платформа компании · стенд';
  const frame = (id, extra) => ({ id, side: 'panel', file: `${id}.png`, text, ...extra });
  const catalog = [
    {
      topic: 't',
      scenario: 's',
      manifest: {
        frames: [
          frame('01-ok', { seal: frameSeal(png, text) }),
          frame('02-text', { seal: frameSeal(png, 'Чат прежней панели · старый стенд') }),
          frame('03-png', { seal: frameSeal(Buffer.from('PNG-до-заплатки'), text) }),
          frame('04-both', { seal: frameSeal(Buffer.from('другой'), 'другой') }),
          frame('05-bare'),
          frame('06-debt'),
        ],
      },
    },
  ];
  const unsealed = { files: ['t/s/06-debt.png', 't/s/99-gone.png', 'other/x/1.png'] };
  const { problems, debt } = sealProblems(catalog, unsealed, () => png);
  const red = (id) => problems.find((problem) => problem.includes(id)) ?? '';
  check('верная пара молчит', red('01-ok') === '');
  check(
    'правленый текст — красное «текст описи изменён»',
    red('02-text').includes('текст описи изменён'),
  );
  check(
    'правленая картинка — красное «картинка изменилась»',
    red('03-png').includes('картинка изменилась'),
  );
  check(
    'обе половины — красное «ни картинка, ни текст»',
    red('04-both').includes('ни картинка, ни текст'),
  );
  check('без печати и без долга — красное', red('05-bare').includes('нет печати кадра'));
  check(
    'кадр в долге не краснеет и назван долгом',
    red('06-debt') === '' && debt.includes('t/s/06-debt.png'),
  );
  check('строка долга без кадра — красное', red('99-gone').includes('числится кадр, которого нет'));
  check('долг чужого раздела вне проверки не трогается', red('other/x') === '');

  const dir = mkdtempSync(join(tmpdir(), 'help-seal-'));
  try {
    const scenario = join(dir, 't', 's');
    mkdirSync(scenario, { recursive: true });
    writeFileSync(
      join(dir, 'unsealed.json'),
      `${JSON.stringify({ files: ['t/s/01-a.en.png'] })}\n`,
    );
    const manifest = {
      topic: 't',
      scenario: 's',
      frames: [frame('01-a', { en: { file: '01-a.en.png', text } })],
    };
    writeFileSync(join(scenario, 'frames.json'), JSON.stringify(manifest));
    writeFileSync(join(scenario, '01-a.en.png'), Buffer.from('заплатка'));
    let refused = false;
    try {
      restampFrame(scenario, '01-a.en.png', { painted: ['Чего нет в тексте'] });
    } catch {
      refused = true;
    }
    check('restampFrame отказывает, если нарисованного нет в тексте', refused);
    restampFrame(scenario, '01-a.en.png', { painted: ['Платформа компании · стенд'] });
    const stamped = JSON.parse(readFileSync(join(scenario, 'frames.json'), 'utf8')).frames[0].en;
    check(
      'restampFrame ставит печать по байтам на диске',
      sealDrift(stamped.seal, Buffer.from('заплатка'), text) === 'ok',
    );
    const left = JSON.parse(readFileSync(join(dir, 'unsealed.json'), 'utf8')).files;
    check('restampFrame снимает кадр с долга', left.length === 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failed;
}
