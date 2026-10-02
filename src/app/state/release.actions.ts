import { createAction, props } from '@ngrx/store';
import type { FirmwareCatalog, ReleaseBatch } from './release.models';

export const createBatch = createAction('[Release] Create batch', props<{ batch: ReleaseBatch }>());
export const approveBatch = createAction('[Release] Approve batch', props<{ id: string; actor: string }>());
export const pauseBatch = createAction('[Release] Pause batch', props<{ id: string; actor: string }>());
export const resumeBatch = createAction('[Release] Resume batch', props<{ id: string; actor: string }>());
export const rollbackBatch = createAction('[Release] Rollback batch', props<{ id: string; actor: string }>());
/** 回退失败后的补偿重试：仍按固件仓库清单验证，失败继续保留补偿记录 */
export const retryCompensation = createAction('[Release] Retry compensation', props<{ id: string; actor: string }>());
/** 人工线下处理闭环（例如现场刷机），记录处置说明 */
export const resolveCompensation = createAction('[Release] Resolve compensation', props<{ id: string; actor: string; note: string }>());
/** 固件仓库升级清单换版：未下发设备随即重算 */
export const reviseCatalog = createAction('[Release] Revise catalog', props<{ catalog: FirmwareCatalog }>());
export const telemetryTick = createAction('[Release] Telemetry tick');
