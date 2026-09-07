/**
 * Прогон эталонных скриншотов, раскладки большого набора и печати отчёта.
 *
 * Идёт ПРЯМО В API живого сервера, без браузера: всё проверяемое здесь — работа
 * сервера, а не экрана. Сравнение картинок, раскладка группы по секциям и ответ
 * «печатать нечем» ломаются молча — панель покажет зелёное там, где эталон не
 * сравнивался вовсе, — поэтому смотреть надо на ответ и на файлы, которые после
 * него остались на диске.
 *
 * Проект берётся свой, во временном каталоге: чужие кейсы этой проверкой трогать
 * нельзя, а её собственные файлы удаляются в конце.
 *
 * PNG собирается здесь же из zlib — ровно как их пишет сервер: заводить ради
 * проверки зависимость, которой нет в самом сервере, значит проверять не то.
 *
 * Запуск: `node tools/qa/check-tests-baselines.mjs` при поднятом `pnpm dev`.
 */
import { deflateSync } from 'node:zlib';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apiFetch } from './api-auth.mjs';

const API = process.env.API_URL ?? 'http://127.0.0.1:5178';

const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? '✓' : '✕'} ${what}`);
  if (!ok) failures.push(what);
};

const project = mkdtempSync(join(tmpdir(), 'cc-qa-baselines-'));
const testsDir = join(project, '.agent', 'tests');

/** Запрос к разделу тестов: тело JSON, ответ — код и разобранное тело. */
async function call(method, path, payload) {
  const url = `${API}/api/project-tests${path}`;
  const response = await apiFetch(url, {
    method,
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const type = response.headers.get('content-type') ?? '';
  const body = type.includes('json')
    ? await response.json()
    : Buffer.from(await response.arrayBuffer());
  return { code: response.status, body };
}

// --- PNG своими руками: подпись, IHDR, IDAT, IEND ---------------------------

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value;
});

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Однотонная картинка, у которой первые `spots` пикселей — другого цвета. */
function png(width, height, spots = 0) {
  const raw = [];
  let index = 0;
  for (let y = 0; y < height; y += 1) {
    raw.push(0);
    for (let x = 0; x < width; x += 1, index += 1) {
      const bright = index < spots;
      raw.push(bright ? 250 : 10, bright ? 250 : 20, bright ? 250 : 30);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const shot = (width, height, spots) => png(width, height, spots).toString('base64');
const baseline = (caseId, pointId, contentBase64) =>
  call('POST', '/baseline', { path: project, caseId, pointId, contentBase64 });

try {
  const alive = await apiFetch(`${API}/api/system`);
  if (!alive.ok) {
    console.error(`Сервер на ${API} не отвечает (${alive.status}). Нужен поднятый pnpm dev.`);
    process.exit(1);
  }

  await call('POST', '/group', { path: project, id: 'gui' });
  const created = await call('POST', '/case', {
    path: project,
    groupId: 'gui',
    testCase: { title: 'Экран входа', steps: [], maxDiffRatio: 0.01 },
  });
  const caseId = created.body?.groups?.[0]?.cases?.[0]?.id ?? 'gui-001';
  check(created.code === 200, `кейс заведён (${caseId})`);

  // 1. Первый снимок сравнивать не с чем — он и становится эталоном.
  const first = await baseline(caseId, 'p1', shot(60, 40));
  check(first.body?.baseline?.status === 'new', 'первый снимок становится эталоном');
  check(
    existsSync(join(project, first.body?.baseline?.file ?? 'нет')),
    'эталон лежит файлом в проекте',
  );

  // 2. Шум ниже порога — совпадение, и никакого мусора рядом.
  const noise = await baseline(caseId, 'p1', shot(60, 40, 12));
  check(noise.body?.baseline?.status === 'match', 'шум ниже порога кейса не роняет прогон');
  check(!noise.body?.baseline?.diffFile, 'при совпадении картинки-разницы не остаётся');

  // 3. Настоящая разница названа, и её видно глазом.
  const changed = await baseline(caseId, 'p1', shot(60, 40, 900));
  const diff = changed.body?.baseline;
  check(diff?.status === 'diff', 'разница выше порога отмечена как расхождение');
  check(Boolean(diff?.diffFile && diff?.actualFile), 'рядом лежат снимок и картинка-разница');
  check(existsSync(join(project, diff?.diffFile ?? 'нет')), 'файл картинки-разницы на диске есть');

  // Картинки клиент тянет ОБЫЧНЫМ маршрутом файлов проекта — их и проверяем
  // тем же запросом, что делает страница: иначе «было/стало» покажет крестики.
  for (const [what, file] of [
    ['эталон', changed.body?.baseline?.file],
    ['снимок', diff?.actualFile],
    ['разница', diff?.diffFile],
  ]) {
    const raw = await apiFetch(
      `${API}/api/project-files/raw?path=${encodeURIComponent(project)}&file=${encodeURIComponent(file ?? '')}`,
    );
    const bytes = raw.ok ? Buffer.from(await raw.arrayBuffer()) : Buffer.alloc(0);
    check(
      raw.status === 200 &&
        raw.headers.get('content-type')?.includes('image/png') &&
        bytes.subarray(1, 4).toString('latin1') === 'PNG',
      `${what} отдаётся обычным /api/project-files/raw (${raw.status})`,
    );
  }

  // 4. Другой размер — названный провал, а не «совпало».
  const resized = await baseline(caseId, 'p1', shot(40, 40));
  check(
    resized.body?.baseline?.status === 'error' &&
      String(resized.body?.baseline?.message ?? '').includes('40'),
    'снимок другого размера — названная ошибка со снятым размером',
  );

  // 5. Эталон меняет только человек — кнопкой «Принять».
  const accepted = await call('POST', '/baseline/accept', { path: project, caseId, pointId: 'p1' });
  check(accepted.body?.baseline?.status === 'match', 'принятый снимок становится эталоном');
  check(
    !existsSync(join(project, diff?.diffFile ?? 'нет')),
    'после принятия картинка-разница убрана',
  );

  const list = await call('GET', `/baselines?path=${encodeURIComponent(project)}`);
  check(Array.isArray(list.body?.baselines) && list.body.baselines.length === 1, 'эталон в списке');

  // 6. Большой набор разъезжается по секциям, а вкладка остаётся одна.
  const many = Array.from({ length: 230 }, (_, index) => ({
    id: `big-${String(index + 1).padStart(3, '0')}`,
    title: `Кейс ${index + 1}`,
    section: ['Чат', 'Аналитика', 'Настройки'][index % 3],
  }));
  mkdirSync(testsDir, { recursive: true });
  writeFileSync(
    join(testsDir, 'big.tests.json'),
    JSON.stringify({ version: 1, title: 'Большой набор', cases: many }, null, 2),
  );
  // Правка через API заставляет сервер переписать группу — тут она и делится.
  const edited = await call('POST', '/case', {
    path: project,
    groupId: 'big',
    testCase: { id: 'big-001', title: 'Кейс 1, поправленный' },
  });
  const big = edited.body?.groups?.find((group) => group.id === 'big');
  check(big?.cases?.length === 230, `разложенная группа читается целиком (${big?.cases?.length})`);
  check((big?.files?.length ?? 0) > 1, `группа лежит несколькими файлами (${big?.files?.length})`);
  check(
    (edited.body?.groups ?? []).length === 2,
    `частей во вкладках нет — групп ровно две (${(edited.body?.groups ?? []).length})`,
  );
  check(
    big?.cases?.[0]?.title === 'Кейс 1, поправленный',
    'правка попала в кейс, уехавший в часть',
  );

  // 7. Печать отчёта: либо PDF, либо честный 501 с именем того, что поставить.
  mkdirSync(join(testsDir, 'runs'), { recursive: true });
  writeFileSync(
    join(testsDir, 'runs', '20260907100000-run-1.run.json'),
    JSON.stringify({
      id: 'run-1',
      mode: 'manual',
      actor: 'human',
      status: 'done',
      startedAt: '2026-09-07T10:00:00.000Z',
      finishedAt: '2026-09-07T10:20:00.000Z',
      results: [
        { pointId: 'gui|gui-001|local', groupId: 'gui', caseId: 'gui-001', status: 'passed' },
      ],
      summary: { total: 1, passed: 1, failed: 0, skipped: 0, blocked: 0 },
    }),
  );

  const pdf = await call('GET', `/run/pdf?path=${encodeURIComponent(project)}&id=run-1`);
  if (pdf.code === 200) {
    check(
      Buffer.isBuffer(pdf.body) && pdf.body.subarray(0, 5).toString('latin1') === '%PDF-',
      `PDF напечатан браузером машины (${pdf.body.length} байт)`,
    );
  } else {
    check(
      pdf.code === 501 && /Chrome|Chromium|Edge/.test(pdf.body?.message ?? ''),
      `браузера нет — честный 501 с именем того, что поставить (${pdf.code})`,
    );
  }

  // 8. Прогон несуществующего отчёта не притворяется отсутствием браузера.
  const missing = await call('GET', `/run/pdf?path=${encodeURIComponent(project)}&id=нет-такого`);
  check(missing.code === 404, `несуществующий прогон — 404, а не 501 (${missing.code})`);
} finally {
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log(failures.length ? `\nПровалов: ${failures.length}` : '\nВсё сошлось');
process.exit(failures.length ? 1 : 0);
