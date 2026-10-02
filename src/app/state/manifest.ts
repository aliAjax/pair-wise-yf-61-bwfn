import type { FirmwareManifest, ManifestEntry, ModelCheck, ModelProgress, GroupModel } from './release.models';

export const MANIFEST_V1 = 'v1';
export const MANIFEST_V2 = 'v2';

const MODELS = ['SG-100', 'SG-200', 'PT-300', 'PT-400', 'CL-500'];
const VERSIONS = ['2.7.9', '2.8.1', '2.9.2', '3.0.0'];

function buildEntries(overrides: Record<string, Partial<ManifestEntry>>): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const model of MODELS) {
    for (const version of VERSIONS) {
      const key = `${model}@${version}`;
      const override = overrides[key] ?? {};
      entries.push({
        model,
        version,
        upgradeable: override.upgradeable ?? true,
        rollbackable: override.rollbackable ?? true,
      });
    }
  }
  return entries;
}

export function createManifest(version: string, overrides: Record<string, Partial<ManifestEntry>> = {}): FirmwareManifest {
  return { version, entries: buildEntries(overrides) };
}

export const initialManifest = createManifest(MANIFEST_V1);

export function nextManifest(current: FirmwareManifest): FirmwareManifest {
  if (current.version === MANIFEST_V1) {
    return createManifest(MANIFEST_V2, {
      'SG-200@3.0.0': { upgradeable: false },
      'SG-200@2.9.2': { rollbackable: false },
    });
  }
  return createManifest(MANIFEST_V1);
}

export function checkModels(manifest: FirmwareManifest, models: GroupModel[], firmware: string, rollbackVersion: string): ModelCheck[] {
  return models.map(({ model, count }) => {
    const target = manifest.entries.find((entry) => entry.model === model && entry.version === firmware);
    const rollback = manifest.entries.find((entry) => entry.model === model && entry.version === rollbackVersion);
    const upgradeOk = target?.upgradeable ?? false;
    const rollbackOk = rollback?.rollbackable ?? false;
    const reasons: string[] = [];
    if (!upgradeOk) reasons.push(`目标版本 ${firmware} 不可升级`);
    if (!rollbackOk) reasons.push(`回滚版本 ${rollbackVersion} 不可回退`);
    return { model, count, upgradeOk, rollbackOk, reason: reasons.join('；') };
  });
}

export function buildModelProgress(models: GroupModel[]): ModelProgress[] {
  return models.map(({ model, count }) => ({ model, count, installed: 0 }));
}

export function effectiveTarget(progress: ModelProgress[], checks: ModelCheck[], rolloutPercent: number): number {
  return progress.reduce((sum, item) => {
    const check = checks.find((c) => c.model === item.model);
    if (!check || !check.upgradeOk) return sum;
    return sum + Math.round(item.count * rolloutPercent / 100);
  }, 0);
}
