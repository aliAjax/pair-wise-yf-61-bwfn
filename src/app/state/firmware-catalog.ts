import type { DeviceGroup, FirmwareCatalog, ModelCatalogEntry, ModelEligibility } from './release.models';

export function getCatalogEntry(catalog: FirmwareCatalog, modelId: string): ModelCatalogEntry | undefined {
  return catalog.entries.find((entry) => entry.modelId === modelId);
}

/**
 * 逐型号对照固件仓库升级清单：
 * 目标版本必须在升级清单里升得上去，回滚版本必须在回退清单里退得回来。
 */
export function checkModel(
  catalog: FirmwareCatalog,
  model: { id: string; name: string; count: number },
  targetVersion: string,
  rollbackVersion: string
): ModelEligibility {
  const entry = getCatalogEntry(catalog, model.id);
  const reasons: string[] = [];
  let targetEligible = false;
  let rollbackEligible = false;

  if (!entry) {
    reasons.push('固件仓库升级清单中没有该型号，无法确认升级与回退路径');
  } else {
    targetEligible = entry.upgradeTargets.includes(targetVersion);
    if (!targetEligible) reasons.push(`目标版本 ${targetVersion} 不在升级清单内，升不上去`);
    rollbackEligible = entry.rollbackTargets.includes(rollbackVersion);
    if (!rollbackEligible) reasons.push(`回滚版本 ${rollbackVersion} 不在可回退清单内，退不回来`);
  }
  if (targetVersion && rollbackVersion && targetVersion === rollbackVersion) {
    reasons.push('目标版本与回滚版本相同，没有退路');
  }

  return {
    modelId: model.id,
    modelName: model.name,
    deviceCount: model.count,
    targetVersion,
    rollbackVersion,
    targetEligible,
    rollbackEligible,
    eligible: targetEligible && rollbackEligible && targetVersion !== rollbackVersion,
    reasons
  };
}

/** 对一个分组里的所有型号逐个核对 */
export function checkGroup(
  catalog: FirmwareCatalog,
  group: DeviceGroup,
  targetVersion: string,
  rollbackVersion: string
): ModelEligibility[] {
  return group.models.map((model) => checkModel(catalog, model, targetVersion, rollbackVersion));
}

export function groupDeviceCount(group: DeviceGroup): number {
  return group.models.reduce((sum, model) => sum + model.count, 0);
}

export function findGroup(groups: DeviceGroup[], groupId: string): DeviceGroup | undefined {
  return groups.find((group) => group.id === groupId);
}

export function cohortTotals(cohorts: { total: number; installed: number; failed: number; blocked: number; rollbackPending: number; rollbackDone: number; rollbackFailed: number }[]) {
  return cohorts.reduce(
    (acc, c) => ({
      total: acc.total + c.total,
      installed: acc.installed + c.installed,
      failed: acc.failed + c.failed,
      blocked: acc.blocked + c.blocked,
      rollbackPending: acc.rollbackPending + c.rollbackPending,
      rollbackDone: acc.rollbackDone + c.rollbackDone,
      rollbackFailed: acc.rollbackFailed + c.rollbackFailed
    }),
    { total: 0, installed: 0, failed: 0, blocked: 0, rollbackPending: 0, rollbackDone: 0, rollbackFailed: 0 }
  );
}
