import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Store } from '@ngrx/store';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { TranslocoPipe } from '@jsverse/transloco';
import { approveBatch, createBatch, pauseBatch, resumeBatch, rollbackBatch, syncManifest, telemetryTick } from './state/release.actions';
import { selectAudits, selectBatches, selectCompensations, selectGroups, selectManifest } from './state/release.selectors';
import { buildModelProgress, checkModels } from './state/manifest';
import type { ReleaseBatch } from './state/release.models';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MatButtonModule, MatCardModule, MatChipsModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatSelectModule, MatTableModule, TranslocoPipe],
  template: `
    <header class="hero">
      <div><span class="eyebrow">OTA CONTROL</span><h1>{{ 'title' | transloco }}</h1><p>{{ 'subtitle' | transloco }}</p></div>
      <mat-chip-set><mat-chip highlighted>审计可追踪</mat-chip><mat-chip>失败阈值自动暂停</mat-chip></mat-chip-set>
    </header>

    <main>
      <section class="stats">
        <mat-card appearance="outlined"><span>批次数</span><strong>{{ (batches$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>兼容分组</span><strong>{{ (groups$ | async)?.length ?? 0 }}</strong></mat-card>
        <mat-card appearance="outlined"><span>已暂停</span><strong>{{ pausedCount() }}</strong></mat-card>
        <mat-card appearance="outlined"><span>待回退</span><strong>{{ pendingRollbackCount() }}</strong></mat-card>
      </section>

      <mat-card appearance="outlined" class="manifest-bar">
        <mat-card-content class="manifest-inner">
          <div><span>固件仓库升级清单版本</span><strong>{{ (manifest$ | async)?.version }}</strong></div>
          <button mat-stroked-button color="primary" (click)="sync()">同步清单</button>
        </mat-card-content>
      </mat-card>

      <section class="grid">
        <mat-card appearance="outlined">
          <mat-card-header><mat-card-title>{{ 'newBatch' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content class="form-grid">
            <mat-form-field><mat-label>批次名称</mat-label><input matInput [(ngModel)]="draft.name"></mat-form-field>
            <mat-form-field><mat-label>目标版本</mat-label><input matInput [(ngModel)]="draft.firmware"></mat-form-field>
            <mat-form-field><mat-label>回滚版本</mat-label><input matInput [(ngModel)]="draft.rollbackVersion"></mat-form-field>
            <mat-form-field><mat-label>设备分组</mat-label><mat-select [(ngModel)]="draft.groupId"><mat-option *ngFor="let group of groups$ | async" [value]="group.id" [disabled]="!group.compatible">{{ group.name }} · {{ group.region }}</mat-option></mat-select></mat-form-field>
            <mat-form-field><mat-label>灰度比例 %</mat-label><input matInput type="number" [(ngModel)]="draft.rolloutPercent"></mat-form-field>
            <mat-form-field><mat-label>失败阈值 %</mat-label><input matInput type="number" [(ngModel)]="draft.failureThreshold"></mat-form-field>
            <div class="model-hint" *ngIf="selectedGroup() as group">组内型号：<span *ngFor="let m of group.models; let last = last">{{ m.model }}（{{ m.count }}）{{ last ? '' : '、' }}</span></div>
            <button mat-flat-button color="primary" (click)="create()">创建批次并对照清单</button>
          </mat-card-content>
        </mat-card>

        <mat-card appearance="outlined" class="batch-panel">
          <mat-card-header><mat-card-title>{{ 'batches' | transloco }}</mat-card-title></mat-card-header>
          <mat-card-content>
            <cdk-virtual-scroll-viewport itemSize="230" class="viewport">
              <article class="batch" *cdkVirtualFor="let batch of batches$ | async">
                <div class="row"><div><b>{{ batch.name }}</b><small>{{ batch.firmware }} → 回滚 {{ batch.rollbackVersion }} · 清单 {{ batch.manifestVersion }}</small></div><mat-chip [color]="batch.status === 'paused' || batch.status === 'rolled_back' ? 'warn' : 'primary'" highlighted>{{ batch.status }}</mat-chip></div>
                <mat-progress-bar mode="determinate" [value]="batch.progress"></mat-progress-bar>
                <div class="row"><span>{{ batch.downloaded }} 台已更新 · 失败 {{ batch.failed }} · 阈值 {{ batch.failureThreshold }}%</span><span>{{ batch.progress }}%</span></div>
                <div class="checks">
                  <div class="check" *ngFor="let check of batch.modelChecks" [class.ok]="check.upgradeOk && check.rollbackOk" [class.bad]="!check.upgradeOk || !check.rollbackOk">
                    <b>{{ check.model }}</b><span *ngIf="check.upgradeOk && check.rollbackOk">可升级 · 可回退</span><span *ngIf="!check.upgradeOk || !check.rollbackOk">{{ check.reason }}</span>
                  </div>
                </div>
                <div class="pending" *ngIf="batch.pendingRollback.length > 0">
                  <div class="pending-title">待回退（已装机）</div>
                  <div class="check bad" *ngFor="let p of batch.pendingRollback"><b>{{ p.model }}</b><span>{{ p.count }} 台 · {{ p.reason }}</span></div>
                </div>
                <div class="actions">
                  <button mat-stroked-button *ngIf="batch.status === 'draft'" (click)="approve(batch.id)">审批</button>
                  <button mat-stroked-button *ngIf="batch.status === 'approved'" (click)="resume(batch.id)">开始发布</button>
                  <button mat-stroked-button *ngIf="batch.status === 'running'" (click)="pause(batch.id)">暂停</button>
                  <button mat-stroked-button *ngIf="batch.status === 'paused'" (click)="resume(batch.id)">继续</button>
                  <button mat-flat-button color="warn" [disabled]="batch.pendingRollback.length === 0" (click)="rollback(batch.id)">紧急回滚</button>
                </div>
              </article>
            </cdk-virtual-scroll-viewport>
          </mat-card-content>
        </mat-card>
      </section>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>补偿记录</mat-card-title></mat-card-header>
        <mat-card-content class="audit-list">
          <div class="audit" *ngFor="let item of compensations$ | async"><span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.model }}</b><p>{{ item.batchName }} · {{ item.reason }}</p></div>
          <div class="empty" *ngIf="(compensations$ | async)?.length === 0">暂无补偿记录</div>
        </mat-card-content>
      </mat-card>

      <mat-card appearance="outlined">
        <mat-card-header><mat-card-title>{{ 'audit' | transloco }}</mat-card-title></mat-card-header>
        <mat-card-content class="audit-list"><div class="audit" *ngFor="let item of audits$ | async"><span>{{ item.at | date:'MM-dd HH:mm:ss' }}</span><b>{{ item.actor }}</b><p>{{ item.message }}</p></div></mat-card-content>
      </mat-card>
    </main>
  `,
  styles: [`
    :host { display:block; min-height:100vh; background:#edf4f5; }
    .hero { padding:36px max(24px,6vw) 28px; color:#fff; background:linear-gradient(125deg,#053b46,#0f6f6c 62%,#2a9d8f); display:flex; justify-content:space-between; gap:24px; align-items:end; }
    .hero h1 { margin:8px 0; font-size:clamp(30px,4vw,52px); letter-spacing:-.04em; } .hero p { margin:0; opacity:.8 } .eyebrow { letter-spacing:.2em; font-size:12px; opacity:.7 }
    main { padding:22px max(18px,5vw) 60px; display:grid; gap:20px; } .stats { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; } .stats span { display:block;color:#607d86 } .stats strong { font-size:30px }
    .manifest-bar .manifest-inner { display:flex; justify-content:space-between; align-items:center; gap:12px; } .manifest-bar span { display:block;color:#607d86;font-size:13px } .manifest-bar strong { font-size:22px }
    .grid { display:grid; grid-template-columns:minmax(300px,.8fr) minmax(420px,1.2fr); gap:20px; } .form-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px; padding-top:16px }
    .model-hint { grid-column:1 / -1; color:#607d86; font-size:13px }
    .viewport { height:640px; } .batch { min-height:220px; border-bottom:1px solid #dde7e8; padding:12px 4px; display:grid; gap:10px } .row { display:flex;justify-content:space-between;gap:12px;align-items:center } small { display:block;color:#71858c } .actions { display:flex;gap:8px;flex-wrap:wrap }
    .checks { display:grid; gap:4px; } .check { display:flex; gap:8px; align-items:center; font-size:13px; padding:4px 8px; border-radius:6px; } .check.ok { background:#e6f4ea; color:#1e6b3a; } .check.bad { background:#fdecea; color:#a32018; }
    .pending { display:grid; gap:4px; } .pending-title { font-size:12px; color:#a32018; font-weight:600; }
    .audit-list { max-height:320px; overflow:auto } .audit { display:grid;grid-template-columns:120px 110px 1fr;border-bottom:1px solid #e5ecee;padding:10px 4px } .audit p { margin:0 } .empty { color:#90a4ae; padding:12px 4px }
    @media(max-width:900px){ .hero{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.audit{grid-template-columns:1fr}.viewport{height:400px} }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly store = inject(Store);
  readonly groups$ = this.store.select(selectGroups);
  readonly batches$ = this.store.select(selectBatches);
  readonly audits$ = this.store.select(selectAudits);
  readonly manifest$ = this.store.select(selectManifest);
  readonly compensations$ = this.store.select(selectCompensations);
  private timer?: number;
  draft = { name: '', firmware: '3.0.0', rollbackVersion: '2.9.2', groupId: 'g-edge', rolloutPercent: 10, failureThreshold: 3 };

  ngOnInit() {
    this.timer = window.setInterval(() => this.store.dispatch(telemetryTick()), 1400);
    this.store.select(selectBatches).subscribe((batches) => {
      const groups = this.snapshotGroups();
      const audits = this.snapshotAudits();
      const manifest = this.snapshotManifest();
      const compensations = this.snapshotCompensations();
      localStorage.setItem('firmware-release-v2', JSON.stringify({ groups, batches, audits, manifest, compensations }));
    });
  }
  ngOnDestroy() { if (this.timer) window.clearInterval(this.timer); }

  selectedGroup() {
    let value: import('./state/release.models').DeviceGroup | undefined;
    this.groups$.subscribe((items) => value = items.find((item) => item.id === this.draft.groupId));
    return value;
  }

  pausedCount() { let count = 0; this.batches$.subscribe((items) => count = items.filter((item) => item.status === 'paused').length); return count; }
  pendingRollbackCount() { let count = 0; this.batches$.subscribe((items) => count += items.reduce((sum, item) => sum + item.pendingRollback.reduce((s, p) => s + p.count, 0), 0)); return count; }

  create() {
    if (!this.draft.name || !this.draft.firmware || !this.draft.groupId) return;
    const group = this.selectedGroup();
    if (!group) return;
    const manifest = this.snapshotManifest();
    if (!manifest) return;
    const batch: ReleaseBatch = {
      ...this.draft,
      id: crypto.randomUUID(),
      status: 'draft',
      progress: 0,
      downloaded: 0,
      failed: 0,
      updatedAt: new Date().toISOString(),
      modelChecks: checkModels(manifest, group.models, this.draft.firmware, this.draft.rollbackVersion),
      modelProgress: buildModelProgress(group.models),
      pendingRollback: [],
      manifestVersion: manifest.version
    };
    this.store.dispatch(createBatch({ batch }));
    this.draft = { ...this.draft, name: '' };
  }
  approve(id: string) { this.store.dispatch(approveBatch({ id, actor: '发布负责人' })); }
  pause(id: string) { this.store.dispatch(pauseBatch({ id, actor: '值班人员' })); }
  resume(id: string) { this.store.dispatch(resumeBatch({ id, actor: '运维人员' })); }
  rollback(id: string) { this.store.dispatch(rollbackBatch({ id, actor: '发布负责人' })); }
  sync() { this.store.dispatch(syncManifest({ actor: '固件仓库' })); }

  private snapshotGroups() { let value: unknown; this.groups$.subscribe((items) => value = items); return value; }
  private snapshotAudits() { let value: unknown; this.audits$.subscribe((items) => value = items); return value; }
  private snapshotManifest() { let value: import('./state/release.models').FirmwareManifest | undefined; this.manifest$.subscribe((items) => value = items); return value; }
  private snapshotCompensations() { let value: unknown; this.compensations$.subscribe((items) => value = items); return value; }
}
