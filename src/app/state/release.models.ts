export type BatchStatus = 'draft' | 'approved' | 'running' | 'paused' | 'completed' | 'rolled_back';

export interface GroupModel {
  model: string;
  count: number;
}

export interface DeviceGroup {
  id: string;
  name: string;
  region: string;
  count: number;
  compatible: boolean;
  offlineGateways: number;
  models: GroupModel[];
}

export interface ManifestEntry {
  model: string;
  version: string;
  upgradeable: boolean;
  rollbackable: boolean;
}

export interface FirmwareManifest {
  version: string;
  entries: ManifestEntry[];
}

export interface ModelCheck {
  model: string;
  count: number;
  upgradeOk: boolean;
  rollbackOk: boolean;
  reason: string;
}

export interface ModelProgress {
  model: string;
  count: number;
  installed: number;
}

export interface PendingRollback {
  model: string;
  count: number;
  reason: string;
}

export interface CompensationRecord {
  id: string;
  at: string;
  batchId: string;
  batchName: string;
  model: string;
  reason: string;
  status: 'failed';
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
  progress: number;
  downloaded: number;
  failed: number;
  updatedAt: string;
  modelChecks: ModelCheck[];
  modelProgress: ModelProgress[];
  pendingRollback: PendingRollback[];
  manifestVersion: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  message: string;
}

export interface ReleaseState {
  groups: DeviceGroup[];
  batches: ReleaseBatch[];
  audits: AuditEntry[];
  manifest: FirmwareManifest;
  compensations: CompensationRecord[];
}
