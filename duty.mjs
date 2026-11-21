// 值班员命令行：node duty.mjs --base http://127.0.0.1:4100 --state .duty/state.json
// 交班后下一班用同一 --state 目录即接着同一轮进度继续做。

import { Collector } from './lib/collector.mjs';
import { planMakeup } from './lib/crew.mjs';
import { sheetTrace, allAlerts } from './lib/handoff.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const base = option('base', 'http://127.0.0.1:4100');
const stateFile = option('state', null);
const asJson = args.includes('--json');

const collector = new Collector(base, { stateFile });
await collector.load();
const { stage, reads, skipped } = await collector.collect();
const evaluation = collector.evaluate();
const catalog = collector.store.catalogs.get(stage);
const now = collector.now();

const sheets = [...evaluation.sheets.values()].map((sheet) => ({
  sheet: sheet.sheet,
  freeze: sheet.freeze,
  ready: sheet.ready,
  cells: sheet.cells,
}));
const continuation = collector.continuation();
const makeup = planMakeup(collector.ledger, evaluation, collector.store, stage, now);
const traces = Object.fromEntries(
  sheets.map((sheet) => [sheet.sheet, sheetTrace(sheet.sheet, evaluation, collector.ledger)]),
);

const report = {
  stage,
  window: catalog ? { open: catalog.open, close: catalog.close, remaining: catalog.remaining } : null,
  collected: skipped ? '本轮已采集过（交班接续）' : reads,
  sheets,
  certificates: [...collector.certificates.values()],
  alerts: allAlerts(collector.ledger, [...collector.certificates.values()], evaluation),
  continuation,
  makeup,
  traces,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const lines = [];
  lines.push(`第 ${stage} 轮（窗口 ${report.window?.open}–${report.window?.close}，剩余额度 ${report.window?.remaining}）`);
  for (const sheet of sheets) {
    lines.push(`赛道 ${sheet.sheet}（截止 ${sheet.freeze}）：${sheet.ready ? '可交接' : '未齐'}`);
    for (const [cell, status] of Object.entries(sheet.cells)) {
      const trace = traces[sheet.sheet].cells[cell];
      lines.push(`  ${cell}: ${status} — ${trace.why}`);
    }
  }
  if (report.certificates.length > 0) {
    lines.push('交接凭据：');
    for (const certificate of report.certificates) {
      lines.push(`  ${certificate.id} ${certificate.sheet} @${certificate.time} 覆盖 ${certificate.region.join(', ')}`);
    }
  }
  if (report.alerts.length > 0) {
    lines.push('限用提醒：');
    for (const alert of report.alerts) {
      lines.push(`  [${alert.type}] 凭据 ${alert.handoff}：${JSON.stringify(alert.cells ?? alert)}`);
    }
  }
  lines.push(`续领：可取 ${continuation.claimable.length} 块，待核 ${continuation.pendingReview.length} 条`);
  for (const task of makeup.tasks) {
    lines.push(
      `补测 ${task.cell}（挡住 ${task.sheets.join('/')}）：` +
        (task.schedulable ? `派 ${task.window}（${task.crew}）` : '暂无可派出勤窗') +
        (task.electronic.pending.length > 0 ? '；有电子读数待核可能补齐' : ''),
    );
  }
  for (const job of makeup.jobs) {
    if (job.cancelRecommended) lines.push(`工单 ${job.job}：${job.note}`);
  }
  console.log(lines.join('\n'));
}
