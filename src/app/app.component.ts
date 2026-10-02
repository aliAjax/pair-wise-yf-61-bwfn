import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { TranslocoPipe } from '@jsverse/transloco';
import { approveBatch, createBatch, pauseBatch, resolveCompensation, resumeBatch, retryCompensation, reviseCatalog, rollbackBatch, telemetryTick } from './state/release.actions';
import { batchProgress, selectAudits, selectBatches, selectCatalog, selectCompensations, selectGroups } from './state/release.selectors';
import { BATCH_STATUS_LABEL, type CompensationRecord, type DeviceGroup, type FirmwareCatalog, type ReleaseBatch } from './state/release.models';
import { checkGroup, cohortTotals, groupDeviceCount } from './state/firmware-catalog';

interface BatchDraft {
  name: string;
  firmware: string;
  rollbackVersion: string;
  groupId: string;
  rolloutPercent: number;
  failureThreshold: number;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div>
        <span class="eyebrow">OTA CONTROL</span>
        <h1>{{ 'title' | transloco }}</h1>
        <p>{{ 'subtitle' | transloco }}</p>
      </div>
      <mat-chip-set>
        <mat-chip highlighted>清单 rev{{ catalog()?.revision }}</mat-chip>
        <mat-chip>审计可追踪</mat-chip>
        <mat-chip>失败阈值自动暂停</mat-chip>
      </mat-chip-set>
    </header>

    <main>
      <section class="stats">
        <mat-card appearance="outlined"><span>发布批次</span><strong>{{ batches().length }}</strong></mat-card>
        <mat-card appearance="outlined"><span>回退失败待补偿</span><strong class="warn-num">{{ pendingCompensations().length }}</strong></mat-card>
        <mat-card appearance="outlined"><span>发布中/暂停</span><strong>{{ liveBatches() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>审计记录</span><strong>{{ audits().length }}</strong></mat-card>
      </section>

      <section class="grid">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>{{ 'newBatch' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content class="form-grid">
            <mat-form-field><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name"></mat-form-field>
            <mat-form-field><mat-label>设备分组</mat-label>
              <mat-select [ngModel]="draft.groupId" (ngModelChange)="selectGroup($event)">
                <mat-option *ngFor="let group of groups()" [value]="group.id">{{ group.name }} · {{ group.region }} · {{ deviceTotal(group) }} 台 / {{ group.models.length }} 型号</mat-option>
              </mat-select>
            </mat-form-field>
            <mat-form-field><mat-label>目标版本</mat-label><input matInput [(ngModel)]="draft.firmware" placeholder="如 2.8.1"></mat-form-field>
            <mat-form-field><mat-label>回滚版本</mat-label><input matInput [(ngModel)]="draft.rollbackVersion" placeholder="如 2.7.9"></mat-form-field>
            <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" min="1" max="100" [(ngModel)]="draft.rolloutPercent"></mat-form-field>
            <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" min="1" max="100" [(ngModel)]="draft.failureThreshold"></mat-form-field>

            <div class="check-panel">
              <div class="check-head">
                <b>逐型号对照固件仓库升级清单</b>
                <span class="rev-tag">当前清单 rev{{ catalog()?.revision }}</span>
              </div>
              <p class="check-hint">分组内型号混装，每个型号都要“升得上去、退得回来”，任一型号不合格都不许审批。</p>
              <div *ngFor="let item of draftChecks()" class="model-line" [class.bad]="!item.eligible">
                <div class="model-main">
                  <span class="dot" [class.ok]="item.eligible" [class.no]="!item.eligible"></span>
                  <b>{{ item.modelName }}</b>
                  <small>{{ item.deviceCount }} 台</small>
                </div>
                <div class="model-tags">
                  <span class="tag" [class.pass]="item.targetEligible" [class.fail]="!item.targetEligible">升级 → {{ item.targetVersion || '?' }}：{{ item.targetEligible ? '清单可升' : '升不上去' }}</span>
                  <span class="tag" [class.pass]="item.rollbackEligible" [class.fail]="!item.rollbackEligible">回退 → {{ item.rollbackVersion || '?' }}：{{ item.rollbackEligible ? '清单可退' : '退不回来' }}</span>
                </div>
                <p *ngIf="item.reasons.length" class="reason">{{ item.reasons.join('；') }}</p>
              </div>
              <div class="check-foot">
                <span *ngIf="draftChecks().length">不合格型号 <b class="warn-num">{{ rejectedDraftModels().length }}</b> / {{ draftChecks().length }} 个：{{ rejectedDraftModels().length ? rejectedNames() : '无，可创建并送审' }}</span>
              </div>
            </div>

            <button mat-flat-button color="primary" (click)="create()">创建批次（草稿）</button>
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined" class="batch-panel">
          <mat-card-header><mat-card-title>{{ 'batches' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <article class="batch" *ngFor="let batch of batches()">
              <div class="row">
                <div>
                  <b>{{ batch.name }}</b>
                  <small>{{ groupName(batch.groupId) }} · 目标 {{ batch.firmware }} → 回退 {{ batch.rollbackVersion }} · 依据清单 rev{{ batch.catalogRevision }} · 灰度 {{ batch.rolloutPercent }}% · 阈值 {{ batch.failureThreshold }}%</small>
                </div>
                <span class="status" [attr.data-status]="batch.status">{{ BATCH_STATUS_LABEL[batch.status] }}</span>
              </div>
              <mat-progress-bar mode="determinate" [value]="progress(batch)"></mat-progress-bar>
              <div class="row meta">
                <span>计划 {{ totals(batch).total }} 台 · 已装 {{ totals(batch).installed }} · 失败 {{ totals(batch).failed }} · 拦截 {{ totals(batch).blocked }}</span>
                <span>{{ progress(batch) }}%</span>
              </div>

              <div class="cohort-table">
                <div class="cohort-head"><span>型号</span><span>计划/已装</span><span>清单核对</span><span>待回退</span><span>已回退/回退失败</span></div>
                <div class="cohort-row" *ngFor="let c of batch.cohorts" [class.bad]="!c.eligible">
                  <span><b>{{ c.modelName }}</b><small *ngIf="c.reasons.length" class="reason">{{ c.reasons.join('；') }}</small></span>
                  <span>{{ c.total }} / {{ c.installed }}<small *ngIf="c.failed">（装失败 {{ c.failed }}）</small><small *ngIf="c.blocked">（已拦截 {{ c.blocked }}）</small></span>
                  <span><span class="dot" [class.ok]="c.eligible" [class.no]="!c.eligible"></span>{{ c.eligible ? '合格' : '不合格（清单已变）' }}</span>
                  <span [class.warn-num]="c.rollbackPending > 0">{{ c.rollbackPending }}</span>
                  <span>{{ c.rollbackDone }}<span class="warn-num" *ngIf="c.rollbackFailed > 0"> / {{ c.rollbackFailed }}</span></span>
                </div>
              </div>

              <div class="rollback-note" *ngIf="pendingRollback(batch) > 0">
                ⚠ 已装原版本设备照原版本走完，以下设备单独列入待回退：<b>{{ pendingRollback(batch) }} 台</b>（清单撤销型号见上表“待回退”列）
              </div>
              <div class="rollback-note danger" *ngIf="batch.status === 'rollback_failed'">
                ⛔ 该批次回退失败，失败设备<b>未</b>记为已回退，请在下方“补偿记录”中处置。
              </div>

              <div class="actions">
                <button mat-stroked-button *ngIf="batch.status === 'draft'" (click)="approve(batch.id)">审批</button>
                <button mat-stroked-button *ngIf="batch.status === 'approved'" (click)="resume(batch.id)">开始发布</button>
                <button mat-stroked-button *ngIf="batch.status === 'running'" (click)="pause(batch.id)">暂停</button>
                <button mat-stroked-button *ngIf="batch.status === 'paused'" (click)="resume(batch.id)">继续</button>
                <button mat-flat-button color="warn" [disabled]="batch.status === 'rolled_back' || batch.status === 'rollback_failed' || totals(batch).installed === 0" (click)="rollback(batch.id)">紧急回滚</button>
              </div>
            </article>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header>
          <mat-card-title>固件仓库升级清单（rev{{ catalog()?.revision }}）</mat-card-title>
        </mat-card-header>
        <mat-card-content>
          <div class="catalog-bar">
            <p>{{ catalog()?.note }} · 更新于 {{ catalog()?.updatedAt | date:'MM-dd HH:mm' }}</p>
            <button mat-stroked-button (click)="simulateRevision()">{{ simulationLabel() }}</button>
          </div>
          <div class="catalog-table">
            <div class="catalog-head"><span>型号</span><span>允许升级到</span><span>允许回退到</span></div>
            <div class="catalog-row" *ngFor="let entry of catalog()?.entries">
              <span><b>{{ entry.modelName }}</b></span>
              <span>{{ entry.upgradeTargets.join('、') || '—' }}</span>
              <span>{{ entry.rollbackTargets.join('、') || '—' }}</span>
            </div>
          </div>
          <p class="check-hint">换版演示：rev4 撤销 X100 对 {{ demoFirmware }} 的升级路径、X200 对 {{ demoRollback }} 的回退路径（发布中的演示批次会立刻拦截未下发设备，已装设备列入待回退，紧急回滚时 X200 会进入补偿）；rev5 恢复路径，可在补偿记录里重试成功。</p>
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined" *ngIf="compensations().length">
        <mat-card-header><mat-card-title>补偿记录（回退失败专用，未闭环不算已回退）</mat-card-title></mat-card-header>
        <mat-card-content>
          <div class="comp-row comp-head"><span>批次 / 型号</span><span>台数/目标版本</span><span>原因</span><span>尝试</span><span>状态/操作</span></div>
          <div class="comp-row" *ngFor="let item of compensations()">
            <span><b>{{ item.batchName }}</b><small>{{ item.modelName }}</small></span>
            <span>{{ item.deviceCount }} 台<small>回退到 {{ item.rollbackVersion }}</small></span>
            <span class="reason">{{ item.reason }}</span>
            <span class="attempts"><small *ngFor="let a of item.attempts">[{{ a.at | date:'MM-dd HH:mm' }}] {{ a.ok ? '成功' : '失败' }}：{{ a.note }}<br></small></span>
            <span>
              <span class="status" [attr.data-status]="item.status === 'pending' ? 'rollback_failed' : 'rolled_back'">{{ item.status === 'pending' ? '待补偿' : '已闭环' }}</span>
              <ng-container *ngIf="item.status === 'pending'">
                <div class="actions"><button mat-stroked-button (click)="retry(item)">按当前清单重试</button></div>
                <input class="resolve-input" placeholder="人工处置说明（如现场刷机）" [(ngModel)]="resolutionNotes[item.id]">
                <button mat-stroked-button (click)="resolve(item, resolutionNotes[item.id] || '人工现场处置完成')">登记人工闭环</button>
              </ng-container>
              <small *ngIf="item.resolutionNote">{{ item.resolutionNote }}</small>
            </span>
          </div>
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>{{ 'audit' | transloco }}</mat-card-title></mat-card-header>
        <mat-card-content class="audit-list">
          <div class="audit" *ngFor="let item of audits()"><span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.actor }}</b><p>{{ item.message }}</p></div>
        </mat-card-content>
      </mat-card>
    </main>
  `,
  styles: [`
    :host { display:block; min-height:100vh; background:#edf4f5; }
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:flex-end; flex-wrap:wrap; }
    .hero h1 { margin:8px 0; font-size:clamp(26px,4vw,46px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.85 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; }
    .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .grid { display:grid; grid-template-columns:minmax(340px,.9fr) minmax(460px,1.1fr); gap:20px; align-items:start; }
    .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:4px 12px; padding-top:16px }
    .form-grid > button { grid-column:1 / -1; margin-top:8px }
    .check-panel { grid-column:1 / -1; border:1px solid #d5e2e4; border-radius:10px; padding:12px; margin-bottom:10px; background:#f7fafb; max-height:340px; overflow:auto; }
    .check-head { display:flex; justify-content:space-between; align-items:center } .rev-tag { font-size:12px; color:#0f6f6c; border:1px solid #9fcbc8; padding:1px 8px; border-radius:10px; }
    .check-hint { font-size:12px; color:#71858c; margin:6px 0 10px; }
    .model-line { border-top:1px dashed #d5e2e4; padding:8px 0; } .model-line.bad { background:#fdf1f1; border-radius:8px; padding:8px; }
    .model-main { display:flex; align-items:center; gap:8px; } .model-main small { color:#71858c }
    .dot { width:9px; height:9px; border-radius:50%; display:inline-block; } .dot.ok { background:#2a9d8f; } .dot.no { background:#d64545; }
    .model-tags { display:flex; gap:8px; flex-wrap:wrap; margin:4px 0 0 18px; }
    .tag { font-size:12px; border-radius:8px; padding:1px 8px; } .tag.pass { background:#e2f3ef; color:#1c7a6d; } .tag.fail { background:#fbe3e3; color:#b3261e; }
    .reason { margin:4px 0 0; font-size:12px; color:#b3261e; }
    .check-foot { font-size:12px; color:#48636b; margin-top:6px; } .warn-num { color:#d64545; }
    .batch { border:1px solid #dde7e8; border-radius:12px; padding:14px; margin-bottom:14px; display:grid; gap:10px; background:#fff; }
    .row { display:flex;justify-content:space-between;gap:12px;align-items:center } small { display:inline;color:#71858c } .row.meta { font-size:12px; color:#48636b }
    .status { font-size:12px; padding:3px 10px; border-radius:12px; white-space:nowrap; background:#e6eef0; color:#27474f; }
    .status[data-status="running"] { background:#e2f3ef; color:#1c7a6d; } .status[data-status="paused"] { background:#fff2da; color:#9a6200; }
    .status[data-status="completed"] { background:#e8edf9; color:#34529e; } .status[data-status="rolled_back"] { background:#e8edea; color:#4b6357; }
    .status[data-status="rollback_failed"] { background:#fbe3e3; color:#b3261e; } .status[data-status="draft"] { background:#eceff1; color:#54676e; }
    .cohort-table { font-size:12px; border:1px solid #e5ecee; border-radius:8px; overflow:hidden; }
    .cohort-head, .cohort-row { display:grid; grid-template-columns:1.4fr 1fr 1.1fr .6fr .9fr; gap:6px; padding:7px 10px; align-items:center; }
    .cohort-head { background:#f2f6f7; font-weight:600; color:#48636b; } .cohort-row { border-top:1px solid #eef2f3; } .cohort-row.bad { background:#fdf6f6; }
    .cohort-row span { display:flex; align-items:center; gap:6px; flex-wrap:wrap; } .cohort-row b { font-weight:600 }
    .rollback-note { font-size:12px; background:#fff7e8; border:1px solid #f0d79f; color:#7a5200; border-radius:8px; padding:8px 10px; }
    .rollback-note.danger { background:#fbeaea; border-color:#e7b5b5; color:#8a1c1c; }
    .actions { display:flex;gap:8px;flex-wrap:wrap; align-items:center; }
    .catalog-bar { display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; } .catalog-bar p { margin:0; font-size:13px; color:#48636b }
    .catalog-table { font-size:13px; border:1px solid #e5ecee; border-radius:8px; overflow:hidden; margin-top:10px; }
    .catalog-head, .catalog-row { display:grid; grid-template-columns:1.2fr 1.4fr 1.4fr; gap:8px; padding:8px 12px; }
    .catalog-head { background:#f2f6f7; font-weight:600; color:#48636b; } .catalog-row { border-top:1px solid #eef2f3; }
    .comp-row { display:grid; grid-template-columns:1fr 1fr 1.4fr 1.6fr 1.2fr; gap:10px; padding:10px 6px; border-bottom:1px solid #eef2f3; font-size:13px; align-items:start; }
    .comp-head { font-weight:600; color:#48636b; background:#f2f6f7; border-radius:8px 8px 0 0; } .comp-row small { display:block; margin-top:2px }
    .attempts { color:#607d8b; line-height:1.5; } .resolve-input { border:1px solid #cfdadd; border-radius:6px; padding:5px 8px; font-size:12px; width:100%; margin:4px 0; }
    .audit-list { max-height:340px; overflow:auto } .audit { display:grid;grid-template-columns:140px 100px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 }
    @media(max-width:980px){.stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.comp-row{grid-template-columns:1fr}.audit{grid-template-columns:1fr}.cohort-head{display:none}.cohort-row{grid-template-columns:1fr 1fr}.catalog-head{display:none}.catalog-row{grid-template-columns:1fr}}
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  readonly BATCH_STATUS_LABEL = BATCH_STATUS_LABEL;
  readonly resolutionNotes: Record<string, string> = {};

  readonly groups = toSignal(this.store.select(selectGroups), { initialValue: [] as DeviceGroup[] });
  readonly batches = toSignal(this.store.select(selectBatches), { initialValue: [] as ReleaseBatch[] });
  readonly audits = toSignal(this.store.select(selectAudits), { initialValue: [] as { id: string; at: string; actor: string; message: string }[] });
  readonly catalog = toSignal<FirmwareCatalog | undefined>(this.store.select(selectCatalog));
  readonly compensations = toSignal(this.store.select(selectCompensations), { initialValue: [] as CompensationRecord[] });

  draft: BatchDraft = { name: '', firmware: '2.8.1', rollbackVersion: '2.8.0', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 3 };

  draftChecks(): { modelId: string; modelName: string; deviceCount: number; targetVersion: string; rollbackVersion: string; targetEligible: boolean; rollbackEligible: boolean; eligible: boolean; reasons: string[] }[] {
    const group = this.groups().find((item) => item.id === this.draft.groupId);
    const catalog = this.catalog();
    if (!group || !catalog) return [];
    return checkGroup(catalog, group, this.draft.firmware.trim(), this.draft.rollbackVersion.trim());
  }
  rejectedDraftModels() { return this.draftChecks().filter((item) => !item.eligible); }
  pendingCompensations() { return this.compensations().filter((item) => item.status === 'pending'); }
  liveBatches() { return this.batches().filter((b) => b.status === 'running' || b.status === 'paused').length; }

  readonly demoFirmware = '2.8.1';
  readonly demoRollback = '2.7.9';

  private timer?: number;

  ngOnInit() {
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1800);
    this.store.subscribe((state) => localStorage.setItem('firmware-release-v2', JSON.stringify(state.release)));
  }
  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  simulationLabel(): string {
    const revision = this.catalog()?.revision;
    if (revision === 3) return '模拟：仓库发布 rev4（撤销 X100 升级路径 / X200 回退路径）';
    if (revision === 4) return '模拟：仓库发布 rev5（恢复两条路径，用于补偿重试）';
    return '模拟：仓库再次换版';
  }

  selectGroup(groupId: string) {
    this.draft.groupId = groupId;
  }

  deviceTotal(group: DeviceGroup): number {
    return groupDeviceCount(group);
  }
  groupName(groupId: string): string {
    return this.groups().find((g) => g.id === groupId)?.name ?? groupId;
  }
  totals(batch: ReleaseBatch) {
    return cohortTotals(batch.cohorts);
  }
  progress(batch: ReleaseBatch): number {
    return batchProgress(batch.cohorts);
  }
  pendingRollback(batch: ReleaseBatch): number {
    return batch.cohorts.reduce((sum, c) => sum + c.rollbackPending, 0);
  }
  rejectedNames(): string {
    return this.rejectedDraftModels().map((m) => m.modelName).join('、');
  }

  create() {
    const d = this.draft;
    if (!d.name.trim() || !d.firmware.trim() || !d.rollbackVersion.trim() || !d.groupId) return;
    const batch: ReleaseBatch = {
      id: crypto.randomUUID(),
      name: d.name.trim(),
      firmware: d.firmware.trim(),
      rollbackVersion: d.rollbackVersion.trim(),
      groupId: d.groupId,
      rolloutPercent: d.rolloutPercent,
      failureThreshold: d.failureThreshold,
      status: 'draft',
      updatedAt: new Date().toISOString(),
      catalogRevision: this.catalog()?.revision ?? 0,
      cohorts: []
    };
    this.store.dispatch(createBatch({ batch }));
    this.draft.name = '';
  }
  approve(id: string) { this.store.dispatch(approveBatch({ id, actor: '发布负责人' })); }
  pause(id: string) { this.store.dispatch(pauseBatch({ id, actor: '值班人员' })); }
  resume(id: string) { this.store.dispatch(resumeBatch({ id, actor: '运维人员' })); }
  rollback(id: string) { this.store.dispatch(rollbackBatch({ id, actor: '发布负责人' })); }
  retry(item: CompensationRecord) { this.store.dispatch(retryCompensation({ id: item.id, actor: '运维人员' })); }
  resolve(item: CompensationRecord, note: string) { this.store.dispatch(resolveCompensation({ id: item.id, actor: '运维值班', note })); }

  simulateRevision() {
    const current = this.catalog();
    if (!current) return;
    const at = new Date().toISOString();
    if (current.revision === 3) {
      const entries = current.entries.map((entry) => {
        if (entry.modelId === 'gw-x100') return { ...entry, upgradeTargets: entry.upgradeTargets.filter((v) => v !== '2.8.1') };
        if (entry.modelId === 'gw-x200') return { ...entry, rollbackTargets: entry.rollbackTargets.filter((v) => v !== '2.7.9') };
        return entry;
      });
      this.store.dispatch(reviseCatalog({ catalog: { revision: 4, updatedAt: at, note: 'X100 暂缓 2.8.1（基带缺陷）；X200 停用 2.7.9 回退路径', entries } }));
    } else {
      const entries = current.entries.map((entry) => {
        if (entry.modelId === 'gw-x100' && !entry.upgradeTargets.includes('2.8.1')) return { ...entry, upgradeTargets: ['2.8.1', ...entry.upgradeTargets] };
        if (entry.modelId === 'gw-x200' && !entry.rollbackTargets.includes('2.7.9')) return { ...entry, rollbackTargets: ['2.7.9', ...entry.rollbackTargets] };
        return entry;
      });
      this.store.dispatch(reviseCatalog({ catalog: { revision: 5, updatedAt: at, note: 'X100 2.8.1 基带缺陷修复，恢复升级与 X200 2.7.9 回退路径', entries } }));
    }
  }
}
