import { createFeatureSelector, createSelector } from '@ngrx/store';
import type { ModelCohort, ReleaseState } from './release.models';
import { cohortTotals } from './firmware-catalog';

export const selectRelease = createFeatureSelector<ReleaseState>('release');
export const selectGroups = createSelector(selectRelease, (state) => state.groups);
export const selectBatches = createSelector(selectRelease, (state) => state.batches);
export const selectAudits = createSelector(selectRelease, (state) => state.audits);
export const selectCatalog = createSelector(selectRelease, (state) => state.catalog);
export const selectCompensations = createSelector(selectRelease, (state) => state.compensations);

export function batchProgress(cohorts: ModelCohort[]): number {
  const totals = cohortTotals(cohorts);
  if (!totals.total) return 0;
  return Math.round((totals.installed + totals.failed + totals.blocked) / totals.total * 100);
}
