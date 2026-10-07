import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HardwareGpu, HardwareInfo } from '@agentdeck/contracts/local-models';
import { i18n } from '@shared/config/i18n';
import { HardwareCard } from './HardwareCard';

/**
 * Строка видеопамяти. На Windows память программ рабочего стола уступается модели,
 * и подбор считает от неё (замер 08.10: 4,1 ГБ стола, 27B встала на 128K целиком) —
 * карточка говорит об этом, иначе «свободно 19,9» спорит с выбранным контекстом.
 */

const GPU: HardwareGpu = {
  vendor: 'nvidia',
  name: 'NVIDIA GeForce RTX 4090',
  vramGb: 24,
  freeGb: 19.9,
  bandwidthGbs: 1008,
  bandwidthFrom: 'table',
};

function render(gpu: HardwareGpu): string {
  const hardware: HardwareInfo = {
    gpus: [gpu],
    ramGb: 95,
    platform: 'win32',
    arch: 'x64',
    detectedBy: 'nvidia-smi',
  };
  return renderToStaticMarkup(
    <HardwareCard hardware={hardware} onRefresh={() => undefined} isRefreshing={false} />,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

describe('HardwareCard: видеопамять', () => {
  it('Windows и стол держит заметную память — сказано, сколько уступят модели', () => {
    const html = render({ ...GPU, pageable: true });
    expect(html).toContain('свободно 19.9 ГБ');
    expect(html).toContain('уступят модели до 21.6 ГБ');
  });

  it('разница в десятые — строки о вытеснении нет', () => {
    const html = render({ ...GPU, freeGb: 21.4, pageable: true });
    expect(html).toContain('свободно 21.4 ГБ');
    expect(html).not.toContain('уступят');
  });

  it('без вытеснения (Linux) — только свободное', () => {
    expect(render(GPU)).not.toContain('уступят');
  });
});
