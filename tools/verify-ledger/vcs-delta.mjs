import fs from 'node:fs';
import path from 'node:path';

/**
 * Поставщик изменений для `vitest run F --changed --experimental.vcsProvider=<этот файл>`
 * (`delta.cjs`): вместо `git diff` отдаёт Δ журнала — изменённое с последнего зелёного
 * того же списка F, путями от пакета. vitest приводит их к своему корню и пересекает
 * фильтры F с тестами, чей граф задевает Δ.
 *
 * Любое сомнение — ошибка, а не пустой список: пустой выбрал бы ноль тестов и дал зелёный
 * без прогона, а сбой обязан быть красным. Корень vitest не тот, от которого считан Δ
 * (`--root`, `root` в конфиге), — пути легли бы мимо графа, и пересечение было бы пустым.
 */
const real = (p) => {
  const r = fs.realpathSync.native(path.resolve(p));
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
};

export default {
  async findChangedFiles(options) {
    const raw = process.env.AGENTDECK_VERIFY_LEDGER_DELTA_FILES;
    const delta = raw ? JSON.parse(raw) : null;
    if (!delta || !Array.isArray(delta.files) || delta.files.length === 0)
      throw new Error('verify-ledger: AGENTDECK_VERIFY_LEDGER_DELTA_FILES is missing or empty');
    if (real(options.root) !== real(delta.root))
      throw new Error(
        // Под замком панели `_DELTA=off` не действует (ревью 25.10, F3), а повтор идёт целиком:
        // красный на ключе сужение не берёт.
        `verify-ledger: vitest root ${options.root} is not the package ${delta.root} the delta was read from; rerun the same command — after this red it runs whole`,
      );
    return delta.files;
  },
};
