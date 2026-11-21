// 赛务台视图：逐格有效证据、当前可用范围、交接凭据与双向追溯。
// 交接凭据（含裁判已收的）只增不改；后来的校时、补测或裁定只追加限用提醒，
// 不能把旧凭据改成"它当时就齐全"。

import { clockText } from './clock.mjs';
import { alertsForHandoff } from './evidence.mjs';

const REASON_TEXT = {
  'no-clock': '没有覆盖该设备时刻的校时回执',
  'layout-boundary': '误差带跨过换架/布点边界，留校时待核',
  'layout-duplicate': '可能时段同时落在多个布点内，归属不明',
  'no-layout': '可能时段内没有布点承认该探头位置',
  'pre-work': '整段早于该格最近一次完工，已被施工覆盖',
  'work-boundary': '误差带跨过该格最近完工时刻，留校时待核',
  'during-work': '施工期间取得，不能用于交还',
};

export function reasonText(reason) {
  return REASON_TEXT[reason] ?? reason;
}

// 逐格视图：有效证据 + 当前可用范围 + 不能用的具体原因。
export function sheetView(sheetName, evaluation) {
  const sheet = evaluation.sheets.get(sheetName);
  if (!sheet) return null;
  const cells = {};
  for (const cell of sheet.cells ? Object.keys(sheet.cells) : []) {
    const state = evaluation.cells.get(cell);
    cells[cell] = {
      status: sheet.cells[cell],
      evidence: sheet.evidence[cell] ?? null,
      unusable: (state?.unusable ?? []).map((ev) => ({
        frame: ev.row.frame,
        seq: ev.row.seq,
        temp: ev.row.temp,
        sources: ev.sources.map((source) => source.block),
        reasons: ev.reasons.map(reasonText),
      })),
      conflicted: (state?.conflicted ?? []).map((ev) => ({
        frame: ev.row.frame,
        seq: ev.row.seq,
        temp: ev.row.temp,
        sources: ev.sources.map((source) => source.block),
      })),
    };
  }
  return {
    sheet: sheet.sheet,
    freeze: sheet.freeze,
    tempRange: sheet.tempRange,
    ready: sheet.ready,
    cells,
  };
}

// 交接凭据列表：裁判已收的 + 本地签发的，各自附当前限用提醒。
export function handoffList(ledger, certificates, evaluation) {
  const list = [];
  for (const handoff of ledger.handoffs()) {
    list.push({
      ...handoff,
      origin: 'referee',
      alerts: evaluation.alerts.filter((alert) => alert.handoff === handoff.id),
    });
  }
  for (const certificate of certificates) {
    list.push({
      ...certificate,
      origin: 'local',
      alerts: alertsForHandoff(certificate, ledger, evaluation.groups),
    });
  }
  return list;
}

// 全部限用提醒：裁判凭据的 + 本地凭据的。
export function allAlerts(ledger, certificates, evaluation) {
  return [
    ...evaluation.alerts,
    ...certificates.flatMap((certificate) =>
      alertsForHandoff(certificate, ledger, evaluation.groups),
    ),
  ];
}

// 从赛道追到等读、重测或限用的具体原因。
export function sheetTrace(sheetName, evaluation, ledger) {
  const sheet = evaluation.sheets.get(sheetName);
  if (!sheet) return null;
  const trace = { sheet: sheetName, freeze: sheet.freeze, ready: sheet.ready, cells: {} };
  for (const cell of Object.keys(sheet.cells)) {
    const status = sheet.cells[cell];
    const state = evaluation.cells.get(cell);
    const entry = { status };
    if (status === 'ok') {
      entry.evidence = sheet.evidence[cell];
      entry.why = '合格证据在册';
    } else if (status === 'out-of-standard') {
      entry.why = `最近可确认测量 ${state.chosen.row.temp}°C 超出 ${sheet.tempRange}，需要重测`;
      entry.reading = { frame: state.chosen.row.frame, seq: state.chosen.row.seq };
    } else if (status === 'pending') {
      entry.why = '有读数留校时/裁定待核，暂不能作为交接依据';
      entry.waiting = (state?.unusable ?? []).map((ev) => ({
        frame: ev.row.frame,
        seq: ev.row.seq,
        reasons: ev.reasons.map(reasonText),
      }));
    } else if (status === 'conflict' || status === 'ambiguous') {
      entry.why = '同架同序号内容冲突或先后无法判定，等来源裁定或重测';
      entry.conflicted = (state?.conflicted ?? []).map((ev) => ({
        frame: ev.row.frame,
        seq: ev.row.seq,
        temp: ev.row.temp,
        sources: ev.sources.map((source) => source.block),
      }));
    } else {
      const stale = (state?.unusable ?? []).map((ev) => ({
        frame: ev.row.frame,
        seq: ev.row.seq,
        reasons: ev.reasons.map(reasonText),
      }));
      entry.why = stale.length > 0 ? '仅有被施工覆盖或施工期间的旧读数，需要重测' : '没有任何读数，等读或重测';
      entry.stale = stale;
    }
    const lastDone = ledger.lastWorkDone(cell);
    entry.lastWorkDone = lastDone === null ? null : clockText(lastDone);
    trace.cells[cell] = entry;
  }
  return trace;
}
