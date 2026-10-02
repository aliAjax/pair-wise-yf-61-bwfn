import { createReducer, on } from '@ngrx/store';
import type { AuditEntry, CompensationRecord, DeviceGroup, FirmwareCatalog, ModelCohort, ReleaseBatch, ReleaseState } from './release.models';
import { approveBatch, createBatch, pauseBatch, resolveCompensation, resumeBatch, retryCompensation, reviseCatalog, rollbackBatch, telemetryTick } from './release.actions';
import { checkModel, cohortTotals } from './firmware-catalog';

const seedAt = new Date().toISOString();

/** 设备分组：同组里混装不同型号，型号决定能不能升 / 能不能退 */
const initialGroups: DeviceGroup[] = [
  {
    id: 'g-edge',
    name: '华东边缘网关',
    region: '华东',
    models: [
      { id: 'gw-x100', name: 'EdgeGateway X100', count: 420 },
      { id: 'gw-x200', name: 'EdgeGateway X200', count: 210 },
      { id: 'gw-l50', name: 'EdgeNode L50', count: 50 }
    ]
  },
  {
    id: 'g-plant',
    name: '工业采集终端',
    region: '华南',
    models: [
      { id: 'plant-a7', name: 'PlantTerminal A7', count: 900 },
      { id: 'plant-a9', name: 'PlantTerminal A9', count: 340 }
    ]
  },
  {
    id: 'g-clinic',
    name: '远程诊疗终端',
    region: '新加坡',
    models: [
      { id: 'med-t3', name: 'ClinicPad T3', count: 180 },
      { id: 'med-t3-lite', name: 'ClinicPad T3 Lite', count: 130 }
    ]
  }
];

/**
 * 固件仓库升级清单 rev3：
 * L50 只能回到 2.7.x 早期版本；草稿里若只填回退 2.8.0，
 * 整个分组里就会出现“没有退路”的型号，审批必须被拦下。
 */
const initialCatalog: FirmwareCatalog = {
  revision: 3,
  updatedAt: seedAt,
  note: '固件仓库当前发布清单 rev3',
  entries: [
    { modelId: 'gw-x100', modelName: 'EdgeGateway X100', upgradeTargets: ['2.8.1', '3.1.0'], rollbackTargets: ['2.7.9', '2.8.0'] },
    { modelId: 'gw-x200', modelName: 'EdgeGateway X200', upgradeTargets: ['2.8.1', '3.1.0'], rollbackTargets: ['2.7.9', '2.8.0'] },
    { modelId: 'gw-l50', modelName: 'EdgeNode L50', upgradeTargets: ['2.7.5', '2.8.1'], rollbackTargets: ['2.7.0', '2.7.4', '2.7.9'] },
    { modelId: 'plant-a7', modelName: 'PlantTerminal A7', upgradeTargets: ['4.2.0', '4.1.3'], rollbackTargets: ['4.1.3', '4.0.9'] },
    { modelId: 'plant-a9', modelName: 'PlantTerminal A9', upgradeTargets: ['4.2.0'], rollbackTargets: ['4.1.3'] },
    { modelId: 'med-t3', modelName: 'ClinicPad T3', upgradeTargets: ['5.0.2', '5.1.0'], rollbackTargets: ['5.0.2', '4.9.8'] },
    { modelId: 'med-t3-lite', modelName: 'ClinicPad T3 Lite', upgradeTargets: ['5.0.2'], rollbackTargets: ['4.9.8'] }
  ]
};

function cohortsFor(batch: ReleaseBatch, groups: DeviceGroup[], catalog: FirmwareCatalog): ModelCohort[] {
  const group = groups.find((item) => item.id === batch.groupId);
  if (!group) return batch.cohorts;
  return group.models.map((model) => {
    const existing = batch.cohorts.find((c) => c.modelId === model.id);
    const result = checkModel(catalog, model, batch.firmware, batch.rollbackVersion);
    return {
      modelId: model.id,
      modelName: model.name,
      total: existing?.total ?? Math.round(model.count * batch.rolloutPercent / 100),
      installed: existing?.installed ?? 0,
      failed: existing?.failed ?? 0,
      blocked: existing?.blocked ?? 0,
      rollbackPending: existing?.rollbackPending ?? 0,
      rollbackDone: existing?.rollbackDone ?? 0,
      rollbackFailed: existing?.rollbackFailed ?? 0,
      eligible: result.eligible,
      targetEligible: result.targetEligible,
      rollbackEligible: result.rollbackEligible,
      reasons: result.reasons
    };
  });
}

const demoBatch: ReleaseBatch = {
  id: 'batch-demo',
  name: '边缘网关安全补丁 2.8.1',
  firmware: '2.8.1',
  rollbackVersion: '2.7.9',
  groupId: 'g-edge',
  rolloutPercent: 20,
  failureThreshold: 5,
  status: 'running',
  updatedAt: seedAt,
  catalogRevision: 3,
  cohorts: []
};
demoBatch.cohorts = cohortsFor(demoBatch, initialGroups, initialCatalog);
// 给演示批次一个进行中的现场：X100 已下发 30/84，X200 20/42
demoBatch.cohorts = demoBatch.cohorts.map((c) =>
  c.modelId === 'gw-x100'
    ? { ...c, installed: 30 }
    : c.modelId === 'gw-x200'
      ? { ...c, installed: 20 }
      : c
);

const initialAudits: AuditEntry[] = [
  { id: 'audit-seed', at: seedAt, actor: '运维值班', message: '固件仓库升级清单 rev3 已载入，批次 batch-demo 按 rev3 审批通过并发布中' }
];

const STORAGE_KEY = 'firmware-release-v2';

function fallbackState(): ReleaseState {
  return {
    catalog: initialCatalog,
    groups: initialGroups,
    batches: [demoBatch],
    audits: initialAudits,
    compensations: []
  };
}

function loadState(): ReleaseState {
  const fallback = fallbackState();
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<ReleaseState> | null;
    if (!parsed || !Array.isArray(parsed.batches) || !parsed.catalog) return fallback;
    // 旧版结构缺少 cohorts/型号清单，不能误用，直接丢弃
    const shaped = parsed.batches.every((b) => Array.isArray(b.cohorts));
    if (!shaped) return fallback;
    return {
      catalog: parsed.catalog ?? fallback.catalog,
      groups: Array.isArray(parsed.groups) && parsed.groups.length ? parsed.groups : initialGroups,
      batches: parsed.batches as ReleaseBatch[],
      audits: Array.isArray(parsed.audits) ? parsed.audits : [],
      compensations: Array.isArray(parsed.compensations) ? parsed.compensations : []
    };
  } catch {
    return fallback;
  }
}

const initialState = loadState();

function audit(state: ReleaseState, actor: string, message: string): AuditEntry[] {
  return [{ id: crypto.randomUUID(), at: new Date().toISOString(), actor, message }, ...state.audits];
}

/**
 * 清单换版后对未结批次重算：
 * - 未下发的设备按新清单随即重算，不合格的剩余台数立即拦截；
 * - 已经装上的照原版本走完，不拦截，并单独计入待回退。
 */
function recomputeOnRevision(state: ReleaseState, catalog: FirmwareCatalog, actor: string): { batches: ReleaseBatch[]; audits: AuditEntry[] } {
  let audits = state.audits;
  const batches = state.batches.map((batch) => {
    if (batch.status === 'rolled_back' || batch.status === 'completed') return batch;
    const group = state.groups.find((item) => item.id === batch.groupId);
    if (!group) return batch;

    let changed = false;
    const cohorts = batch.cohorts.map((cohort) => {
      const model = group.models.find((m) => m.id === cohort.modelId);
      if (!model) return cohort;
      const result = checkModel(catalog, model, batch.firmware, batch.rollbackVersion);
      if (result.eligible === cohort.eligible && result.targetEligible === cohort.targetEligible && result.rollbackEligible === cohort.rollbackEligible) {
        return { ...cohort, reasons: result.reasons };
      }
      changed = true;
      if (!result.eligible) {
        const undispatched = Math.max(0, cohort.total - cohort.installed - cohort.failed - cohort.blocked);
        if (undispatched > 0 || cohort.installed > 0) {
          audits = audit(
            { ...state, audits },
            actor,
            `清单 rev${catalog.revision} 生效：批次 ${batch.name} 的 ${cohort.modelName} 不合格（${result.reasons.join('；')}），${undispatched} 台未下发设备已拦截${cohort.installed > 0 ? `，${cohort.installed} 台已装 ${batch.firmware} 照原版本走完并列入待回退` : ''}`
          );
        }
        return {
          ...cohort,
          eligible: false,
          targetEligible: result.targetEligible,
          rollbackEligible: result.rollbackEligible,
          reasons: result.reasons,
          blocked: cohort.blocked + undispatched,
          rollbackPending: cohort.installed
        };
      }
      return { ...cohort, eligible: true, targetEligible: true, rollbackEligible: true, reasons: [] };
    });
    return changed ? { ...batch, cohorts, catalogRevision: catalog.revision, updatedAt: new Date().toISOString() } : batch;
  });
  return { batches, audits };
}

export const releaseReducer = createReducer(
  initialState,
  on(createBatch, (state, { batch }) => ({
    ...state,
    batches: [batch, ...state.batches],
    audits: audit(state, '发布负责人', `创建批次 ${batch.name}（目标 ${batch.firmware} / 回退 ${batch.rollbackVersion}），待按型号核对后审批`)
  })),
  on(approveBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || batch.status !== 'draft') return state;
    const withCohorts: ReleaseBatch = { ...batch, catalogRevision: state.catalog.revision, cohorts: cohortsFor(batch, state.groups, state.catalog) };
    const rejected = withCohorts.cohorts.filter((c) => !c.eligible);
    if (rejected.length > 0) {
      const detail = rejected.map((c) => `${c.modelName}（${c.reasons.join('；')}）`).join('；');
      return { ...state, audits: audit(state, actor, `批次 ${batch.name} 审批驳回：${rejected.length} 个型号不合格 —— ${detail}`) };
    }
    return {
      ...state,
      batches: state.batches.map((item) => (item.id === id ? { ...withCohorts, status: 'approved', updatedAt: new Date().toISOString() } : item)),
      audits: audit(state, actor, `批次 ${batch.name} 全部型号核对通过（清单 rev${state.catalog.revision}），审批通过`)
    };
  }),
  on(pauseBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || (batch.status !== 'running' && batch.status !== 'approved')) return state;
    return {
      ...state,
      batches: state.batches.map((item) => (item.id === id ? { ...item, status: 'paused', updatedAt: new Date().toISOString() } : item)),
      audits: audit(state, actor, `批次 ${batch.name} 已暂停`)
    };
  }),
  on(resumeBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || (batch.status !== 'paused' && batch.status !== 'approved')) return state;
    return {
      ...state,
      batches: state.batches.map((item) => (item.id === id ? { ...item, status: 'running', updatedAt: new Date().toISOString() } : item)),
      audits: audit(state, actor, `批次 ${batch.name} ${batch.status === 'approved' ? '开始发布' : '继续发布'}`)
    };
  }),
  on(rollbackBatch, (state, { id, actor }) => {
    const batch = state.batches.find((item) => item.id === id);
    if (!batch || batch.status === 'rolled_back' || batch.status === 'rollback_failed') return state;

    let audits = state.audits;
    const newCompensations: CompensationRecord[] = [];
    const cohorts = batch.cohorts.map((cohort) => {
      const pending = Math.max(cohort.rollbackPending, cohort.installed) - cohort.rollbackDone - cohort.rollbackFailed;
      if (pending <= 0) return cohort;
      // 照“当前”固件仓库清单判定能不能退回来
      const model = state.groups.find((g) => g.id === batch.groupId)?.models.find((m) => m.id === cohort.modelId);
      const result = model ? checkModel(state.catalog, model, batch.firmware, batch.rollbackVersion) : null;
      const canRollBack = result?.rollbackEligible ?? false;
      if (canRollBack) {
        audits = audit({ ...state, audits }, actor, `批次 ${batch.name} 的 ${cohort.modelName}：${pending} 台已回退到 ${batch.rollbackVersion}`);
        return { ...cohort, rollbackDone: cohort.rollbackDone + pending, rollbackPending: 0, installed: cohort.installed };
      }
      audits = audit(
        { ...state, audits },
        actor,
        `批次 ${batch.name} 的 ${cohort.modelName}：${pending} 台回退 ${batch.rollbackVersion} 失败（${result?.reasons.join('；') ?? '型号不在清单中'}），保留补偿记录，不得记为已回退`
      );
      newCompensations.push({
        id: crypto.randomUUID(),
        batchId: batch.id,
        batchName: batch.name,
        modelId: cohort.modelId,
        modelName: cohort.modelName,
        deviceCount: pending,
        rollbackVersion: batch.rollbackVersion,
        reason: `回退版本 ${batch.rollbackVersion} 不在当前清单 rev${state.catalog.revision} 的可回退清单内`,
        at: new Date().toISOString(),
        status: 'pending',
        attempts: [{ at: new Date().toISOString(), ok: false, note: '紧急回退时按清单校验未通过' }]
      });
      return { ...cohort, rollbackFailed: cohort.rollbackFailed + pending, rollbackPending: 0 };
    });

    const failedCount = newCompensations.reduce((sum, item) => sum + item.deviceCount, 0);
    const status: ReleaseBatch['status'] = failedCount > 0 ? 'rollback_failed' : 'rolled_back';
    audits = audit({ ...state, audits }, actor, failedCount > 0 ? `批次 ${batch.name} 紧急回滚部分失败，状态置为回退失败（待补偿）` : `批次 ${batch.name} 紧急回滚完成`);

    return {
      ...state,
      batches: state.batches.map((item) => (item.id === id ? { ...item, cohorts, status, updatedAt: new Date().toISOString() } : item)),
      audits,
      compensations: [...newCompensations, ...state.compensations]
    };
  }),
  on(retryCompensation, (state, { id, actor }) => {
    const record = state.compensations.find((item) => item.id === id);
    if (!record || record.status !== 'pending') return state;
    const model = state.groups.find((g) => g.id === state.batches.find((b) => b.id === record.batchId)?.groupId)?.models.find((m) => m.id === record.modelId);
    const result = model ? checkModel(state.catalog, model, state.batches.find((b) => b.id === record.batchId)!.firmware, record.rollbackVersion) : null;
    const at = new Date().toISOString();
    if (result?.rollbackEligible) {
      const compensations = state.compensations.map((item) =>
        item.id === id
          ? { ...item, status: 'resolved' as const, attempts: [...item.attempts, { at, ok: true, note: `清单 rev${state.catalog.revision} 已恢复回退路径，重试成功` }], resolutionNote: '补偿重试回退成功' }
          : item
      );
      let batches = state.batches.map((batch) =>
        batch.id === record.batchId
          ? {
              ...batch,
              cohorts: batch.cohorts.map((c) =>
                c.modelId === record.modelId
                  ? { ...c, rollbackDone: c.rollbackDone + record.deviceCount, rollbackFailed: Math.max(0, c.rollbackFailed - record.deviceCount) }
                  : c
              )
            }
          : batch
      );
      // 最后一条补偿闭环后，批次才转为已回退；此前一直挂在回退失败
      if (!compensations.some((item) => item.batchId === record.batchId && item.status === 'pending')) {
        batches = batches.map((batch) => (batch.id === record.batchId ? { ...batch, status: 'rolled_back' as const } : batch));
      }
      return { ...state, compensations, batches, audits: audit(state, actor, `补偿记录 ${record.modelName} 重试回退成功，${record.deviceCount} 台已回到 ${record.rollbackVersion}`) };
    }
    const compensations = state.compensations.map((item) =>
      item.id === id ? { ...item, attempts: [...item.attempts, { at, ok: false, note: `清单 rev${state.catalog.revision} 仍无回退路径` }] } : item
    );
    return { ...state, compensations, audits: audit(state, actor, `补偿记录 ${record.modelName} 重试仍失败，继续保留待补偿（不得记为已回退）`) };
  }),
  on(resolveCompensation, (state, { id, actor, note }) => {
    const record = state.compensations.find((item) => item.id === id);
    if (!record || record.status !== 'pending') return state;
    const at = new Date().toISOString();
    const compensations = state.compensations.map((item) =>
      item.id === id ? { ...item, status: 'resolved' as const, resolutionNote: note, attempts: [...item.attempts, { at, ok: true, note: `人工闭环：${note}` }] } : item
    );
    let batches = state.batches;
    if (!compensations.some((item) => item.batchId === record.batchId && item.status === 'pending')) {
      // 人工闭环也必须把每一笔失败处置完，批次才能离开“回退失败”
      batches = batches.map((batch) => (batch.id === record.batchId ? { ...batch, status: 'rolled_back' as const } : batch));
    }
    return { ...state, compensations, batches, audits: audit(state, actor, `补偿记录 ${record.modelName} ${record.deviceCount} 台由人工处置闭环：${note}`) };
  }),
  on(reviseCatalog, (state, { catalog }) => {
    const { batches, audits } = recomputeOnRevision(state, catalog, '固件仓库');
    return {
      ...state,
      catalog,
      batches,
      audits: audit({ ...state, audits }, '固件仓库', `升级清单更新为 rev${catalog.revision}：${catalog.note}，未下发设备已按新清单重算`)
    };
  }),
  on(telemetryTick, (state) => {
    let audits = state.audits;
    let autoPaused = false;
    const batches = state.batches.map((batch) => {
      if (batch.status !== 'running') return batch;
      let cohorts = batch.cohorts;
      const before = cohortTotals(cohorts);
      cohorts = cohorts.map((cohort) => {
        if (!cohort.eligible) return cohort; // 清单拦截：未下发的不再推送
        const remaining = cohort.total - cohort.installed - cohort.failed - cohort.blocked;
        if (remaining <= 0) return cohort;
        const increment = Math.min(remaining, Math.max(2, Math.round(cohort.total * 0.18)));
        // 模拟少量安装失败
        const failures = Math.min(remaining - increment, Math.random() < 0.05 ? 1 : 0);
        return { ...cohort, installed: cohort.installed + increment, failed: cohort.failed + failures };
      });
      const totals = cohortTotals(cohorts);
      const failureRate = totals.installed ? totals.failed / totals.installed * 100 : 0;
      const dispatched = totals.installed + totals.failed + totals.blocked;
      let status: ReleaseBatch['status'] = batch.status;
      if (failureRate > batch.failureThreshold) {
        status = 'paused';
        autoPaused = true;
      } else if (dispatched >= totals.total && totals.total > 0) {
        status = 'completed';
      } else {
        status = 'running';
      }
      const changed = before.installed !== totals.installed || before.failed !== totals.failed || status !== batch.status;
      return changed ? { ...batch, cohorts, status, updatedAt: new Date().toISOString() } : batch;
    });
    if (autoPaused) audits = audit(state, '系统', '失败率超过阈值，已自动暂停发布');
    return autoPaused ? { ...state, batches, audits } : { ...state, batches };
  })
);
