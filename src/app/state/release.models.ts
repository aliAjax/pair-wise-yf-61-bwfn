export type BatchStatus =
  | 'draft'
  | 'approved'
  | 'running'
  | 'paused'
  | 'completed'
  | 'rolled_back'
  | 'rollback_failed';

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  draft: '草稿',
  approved: '已审批',
  running: '发布中',
  paused: '已暂停',
  completed: '已完成',
  rolled_back: '已回退',
  rollback_failed: '回退失败（待补偿）'
};

/** 分组里的一个具体型号 */
export interface DeviceModel {
  id: string;
  name: string;
  count: number;
}

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  models: DeviceModel[];
}

/** 固件仓库升级清单中，单个型号允许升 / 允许退的版本 */
export interface ModelCatalogEntry {
  modelId: string;
  modelName: string;
  /** 允许升级到的目标版本清单 */
  upgradeTargets: string[];
  /** 允许回退到的版本清单 */
  rollbackTargets: string[];
}

/** 固件仓库升级清单（带版本号，清单一变未下发设备要重算） */
export interface FirmwareCatalog {
  revision: number;
  updatedAt: string;
  note: string;
  entries: ModelCatalogEntry[];
}

/** 某个型号对“目标版本 / 回滚版本”的逐项核对结果 */
export interface ModelEligibility {
  modelId: string;
  modelName: string;
  deviceCount: number;
  targetVersion: string;
  rollbackVersion: string;
  targetEligible: boolean;
  rollbackEligible: boolean;
  eligible: boolean;
  reasons: string[];
}

/** 批次内单个型号的推进台账 */
export interface ModelCohort {
  modelId: string;
  modelName: string;
  /** 该型号本次灰度计划下发的台数（审批时按比例固化） */
  total: number;
  /** 已装上目标版本 */
  installed: number;
  /** 安装失败 */
  failed: number;
  /** 清单变更后被拦截、不再下发的未下发台数 */
  blocked: number;
  /** 已装原版本、等待回退的台数（清单撤销后单独列出） */
  rollbackPending: number;
  /** 已成功回退 */
  rollbackDone: number;
  /** 回退失败，等待补偿 */
  rollbackFailed: number;
  /** 按当前清单重算后的资格 */
  eligible: boolean;
  targetEligible: boolean;
  rollbackEligible: boolean;
  reasons: string[];
}

export interface ReleaseBatch {
  id: string;
  name: string;
  firmware: string;
  rollbackVersion: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
  status: BatchStatus;
  updatedAt: string;
  /** 审批通过时所依据的清单版本 */
  catalogRevision: number;
  cohorts: ModelCohort[];
}

export interface CompensationRecord {
  id: string;
  batchId: string;
  batchName: string;
  modelId: string;
  modelName: string;
  deviceCount: number;
  rollbackVersion: string;
  reason: string;
  at: string;
  status: 'pending' | 'resolved';
  attempts: { at: string; ok: boolean; note: string }[];
  resolutionNote?: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
}

export interface ReleaseState {
  catalog: FirmwareCatalog;
  groups: DeviceGroup[];
  batches: ReleaseBatch[];
  audits: AuditEntry[];
  compensations: CompensationRecord[];
}
