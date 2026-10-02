import { createReducer, on } from '@ngrx/store';
import type { AuditEntry, CompensationRecord, DeviceGroup, FirmwareManifest, ModelCheck, PendingRollback, ReleaseBatch, ReleaseState } from './release.models';
import { approveBatch, createBatch, pauseBatch, resumeBatch, rollbackBatch, syncManifest, telemetryTick } from './release.actions';
import { buildModelProgress, checkModels, effectiveTarget, initialManifest, nextManifest } from './manifest';

const now = new Date().toISOString();

const initialGroups: DeviceGroup[] = [
  { id: 'g-edge', name: '华东边缘网关', region: '华东', count: 680, compatible: true, offlineGateways: 4, models: [{ model: 'SG-100', count: 360 }, { model: 'SG-200', count: 320 }] },
  { id: 'g-plant', name: '工业采集终端', region: '华南', count: 1240, compatible: false, offlineGateways: 12, models: [{ model: 'PT-300', count: 640 }, { model: 'PT-400', count: 600 }] },
  { id: 'g-clinic', name: '远程诊疗终端', region: '新加坡', count: 310, compatible: true, offlineGateways: 2, models: [{ model: 'CL-500', count: 310 }] }
];

const demoGroup = initialGroups[0];
const demoChecks = checkModels(initialManifest, demoGroup.models, '2.8.1', '2.7.9');
const initialBatches: ReleaseBatch[] = [
  {
    id: 'batch-demo', name: '边缘网关安全补丁 2.8.1', firmware: '2.8.1', rollbackVersion: '2.7.9', groupId: 'g-edge',
    rolloutPercent: 20, failureThreshold: 5, status: 'approved', progress: 0, downloaded: 0, failed: 0, updatedAt: now,
    modelChecks: demoChecks, modelProgress: buildModelProgress(demoGroup.models), pendingRollback: [], manifestVersion: initialManifest.version
  }
];
const initialAudits: AuditEntry[] = [{ id: 'audit-1', at: now, actor: '运维值班', message: '批次 batch-demo 完成兼容性检查并进入已审批' }];

const STORAGE_KEY = 'firmware-release-v2';
const fallback: ReleaseState = { groups: initialGroups, batches: initialBatches, audits: initialAudits, manifest: initialManifest, compensations: [] };
const stored = typeof localStorage === 'undefined' ? fallback : JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as ReleaseState | null;
const initialState = stored ?? fallback;

function audit(state: ReleaseState, actor: string, message: string): AuditEntry[] {
  return [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, message }, ...state.audits];
}

function findGroup(state: ReleaseState, groupId: string): DeviceGroup {
  return state.groups.find((item) => item.id === groupId) as DeviceGroup;
}

function blockedModels(checks: ModelCheck[]): ModelCheck[] {
  return checks.filter((check) => !check.upgradeOk || !check.rollbackOk);
}

function withRecomputedChecks(batch: ReleaseBatch, manifest: FirmwareManifest, group: DeviceGroup): ReleaseBatch {
  const modelChecks = checkModels(manifest, group.models, batch.firmware, batch.rollbackVersion);
  return { ...batch, modelChecks, manifestVersion: manifest.version };
}

export const releaseReducer = createReducer(
  initialState,
  on(createBatch, (state, { batch }) => {
    const group = findGroup(state, batch.groupId);
    const modelChecks = checkModels(state.manifest, group.models, batch.firmware, batch.rollbackVersion);
    const stored: ReleaseBatch = {
      ...batch,
      modelChecks,
      modelProgress: buildModelProgress(group.models),
      pendingRollback: [],
      manifestVersion: state.manifest.version
    };
    return { ...state, batches: [stored, ...state.batches], audits: audit(state, '发布负责人', `创建批次 ${batch.name}，已对照清单 ${state.manifest.version} 逐型号检查`) };
  }),
  on(approveBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch) return state;
    const group = findGroup(state, batch.groupId);
    const modelChecks = checkModels(state.manifest, group.models, batch.firmware, batch.rollbackVersion);
    const blocked = blockedModels(modelChecks);
    if (blocked.length > 0) {
      const names = blocked.map((item) => `${item.model}（${item.reason}）`).join('、');
      return {
        ...state,
        batches: state.batches.map((item) => item.id === id ? { ...item, modelChecks, manifestVersion: state.manifest.version } : item),
        audits: audit(state, actor, `批次 ${id} 审批被拒绝：型号 ${names} 不符合清单要求`)
      };
    }
    return {
      ...state,
      batches: state.batches.map((item) => item.id === id ? { ...item, status: 'approved', modelChecks, manifestVersion: state.manifest.version, updatedAt: new Date().toISOString() } : item),
      audits: audit(state, actor, `批次 ${id} 审批通过，所有型号均符合清单 ${state.manifest.version} 要求`)
    };
  }),
  on(pauseBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'paused', updatedAt: new Date().toISOString() } : batch),
    audits: audit(state, actor, `批次 ${id} 已暂停`)
  })),
  on(resumeBatch, (state, { id, actor }) => ({
    ...state,
    batches: state.batches.map((batch) => batch.id === id ? { ...batch, status: 'running', updatedAt: new Date().toISOString() } : batch),
    audits: audit(state, actor, `批次 ${id} 恢复发布`)
  })),
  on(rollbackBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch) return state;
    const group = findGroup(state, batch.groupId);
    const modelChecks = checkModels(state.manifest, group.models, batch.firmware, batch.rollbackVersion);
    const compensations: CompensationRecord[] = [];
    const resolved: string[] = [];
    const stillPending: PendingRollback[] = [];
    for (const pending of batch.pendingRollback) {
      const check = modelChecks.find((item) => item.model === pending.model);
      if (check?.rollbackOk) {
        resolved.push(pending.model);
      } else {
        const reason = `${pending.model} 回滚版本 ${batch.rollbackVersion} 不可回退，回滚失败`;
        compensations.push({ id: crypto.randomUUID(), at: new Date().toISOString(), batchId: id, batchName: batch.name, model: pending.model, reason, status: 'failed' });
        stillPending.push(pending);
      }
    }
    const allResolved = stillPending.length === 0 && batch.pendingRollback.length > 0;
    const audits = [...state.audits];
    if (resolved.length > 0) audits.push({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, message: `批次 ${id} 已回退 ${resolved.join('、')} 型号` });
    if (compensations.length > 0) audits.push({ id: crypto.randomUUID(), at: new Date().toISOString(), actor: '系统', message: `批次 ${id} 回滚失败：${compensations.map((item) => item.model).join('、')}，已生成补偿记录` });
    return {
      ...state,
      batches: state.batches.map((item) => item.id === id ? {
        ...item,
        status: allResolved ? 'rolled_back' : item.status,
        pendingRollback: stillPending,
        modelChecks,
        manifestVersion: state.manifest.version,
        updatedAt: new Date().toISOString()
      } : item),
      audits,
      compensations: [...compensations, ...state.compensations]
    };
  }),
  on(syncManifest, (state, { actor }) => {
    const manifest = nextManifest(state.manifest);
    const batches = state.batches.map((batch): ReleaseBatch => {
      const group = findGroup(state, batch.groupId);
      const recomputed = withRecomputedChecks(batch, manifest, group);
      if (batch.status !== 'running' && batch.status !== 'paused') return recomputed;
      const blocked = blockedModels(recomputed.modelChecks);
      if (blocked.length === 0) return { ...recomputed, status: batch.status === 'paused' ? 'paused' : 'running' };
      const pendingRollback: PendingRollback[] = blocked
        .filter((check) => !check.upgradeOk)
        .filter((check) => (batch.modelProgress.find((p) => p.model === check.model)?.installed ?? 0) > 0)
        .map((check) => ({
          model: check.model,
          count: batch.modelProgress.find((p) => p.model === check.model)?.installed ?? 0,
          reason: `清单 ${manifest.version} 已移除 ${batch.firmware} 的升级许可，已装机设备待回退`
        }));
      return { ...recomputed, status: 'paused', pendingRollback };
    });
    const overflow = batches.some((batch, index) => {
      const before = state.batches[index];
      return before && before.status !== 'paused' && batch.status === 'paused' && blockedModels(batch.modelChecks).length > 0;
    });
    const audits = overflow
      ? [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, message: `固件仓库清单已更新至 ${manifest.version}，未下发设备已重算，不合格型号已暂停发布并列出待回退` }, ...state.audits]
      : state.audits;
    return { ...state, manifest, batches, audits };
  }),
  on(telemetryTick, (state) => {
    const batches = state.batches.map((batch) => {
      if (batch.status !== 'running') return batch;
      const group = findGroup(state, batch.groupId);
      const modelChecks = checkModels(state.manifest, group.models, batch.firmware, batch.rollbackVersion);
      const blocked = blockedModels(modelChecks);
      const modelProgress = batch.modelProgress.map((progress) => {
        const check = modelChecks.find((item) => item.model === progress.model);
        if (!check || !check.upgradeOk) return progress;
        const target = Math.round(progress.count * batch.rolloutPercent / 100);
        const increment = Math.max(2, Math.round(target * 0.06));
        const installed = Math.min(target, progress.installed + increment);
        return { ...progress, installed };
      });
      const downloaded = modelProgress.reduce((sum, item) => sum + item.installed, 0);
      const failed = batch.failed + (Math.random() < 0.08 ? 1 : 0);
      const failureRate = downloaded ? failed / downloaded * 100 : 0;
      const target = effectiveTarget(modelProgress, modelChecks, batch.rolloutPercent);
      const done = downloaded >= target && target > 0;
      const hasPending = blocked.some((check) => !check.upgradeOk) && downloaded > 0;
      const status: ReleaseBatch['status'] = failureRate > batch.failureThreshold ? 'paused' : done && !hasPending ? 'completed' : 'running';
      return { ...batch, modelChecks, modelProgress, downloaded, failed, progress: target ? Math.round(downloaded / target * 100) : 0, status, updatedAt: new Date().toISOString() };
    });
    const overflow = batches.some((batch, index) => batch.status === 'paused' && state.batches[index]?.status === 'running');
    return { ...state, batches, audits: overflow ? audit(state, '系统', '失败率超过阈值，已自动暂停发布') : state.audits };
  })
);
