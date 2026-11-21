// 证据库：汇总各轮取回的原件读数，结合台账（校时、布点、施工、裁定、赛务规则）
// 判定每条读数的归属与可用性，并给出每格、每赛道的交接状态。
//
// 关键约定：
// - 同一架同一序号内容完全一致的多份原件视为同一读数的多个来源（中继转发去重）。
// - 内容冲突且来源台账尚无裁定时，两份都保留可回查，但都不得用于交接；
//   裁定只影响点名的架和序号。
// - 读数的可能赛场时段 = 设备时刻 + 校时误差端点（闭区间）。只有整个可能时段
//   落在同一有效布点内、且不早于该格最近一次施工完工时刻，读数才能作为交接依据；
//   误差带跨过布点或施工边界的留在待核区，等校时补证。
// - 施工期间取得的同格读数不能用于交还；未施工的格继续沿用合格证据。

import { minutes, possibleWindow, overlaps } from './clock.mjs';

export function contentKeyOf(row) {
  return [row.frame, row.seq, row.cal, row.probe, row.temp, row.time].join('|');
}

// 仍可能靠补证（校时回执收窄误差带、来源裁定）转为可用的原因。
export const RESOLVABLE_REASONS = new Set(['layout-boundary', 'work-boundary']);

export class EvidenceStore {
  constructor() {
    // "frame/seq" -> { frame, seq, contents: Map<contentKey, {row, sources:[{block, stage}]}> }
    this.groups = new Map();
    this.blockRows = new Map(); // blockId -> rows
    this.catalogs = new Map(); // stage -> catalog
    this.readLog = []; // 每次有效读取（含坏包）的额度占用记录
  }

  addCatalog(stage, catalog) {
    this.catalogs.set(stage, catalog);
  }

  noteRead(stage, id, cost, status, shaOk) {
    this.readLog.push({ stage, block: id, cost, status, shaOk });
  }

  addBlockRows(id, rows, stage) {
    if (this.blockRows.has(id)) return;
    this.blockRows.set(id, rows);
    for (const row of rows) {
      const key = `${row.frame}/${row.seq}`;
      if (!this.groups.has(key)) {
        this.groups.set(key, { frame: row.frame, seq: row.seq, contents: new Map() });
      }
      const group = this.groups.get(key);
      const contentKey = contentKeyOf(row);
      if (!group.contents.has(contentKey)) {
        group.contents.set(contentKey, { row, sources: [] });
      }
      const content = group.contents.get(contentKey);
      if (!content.sources.some((source) => source.block === id)) {
        content.sources.push({ block: id, stage });
      }
    }
  }

  evaluate(ledger) {
    const resolutions = ledger.resolutions();
    const readings = new Map(); // contentKey -> 评估结果
    const groups = new Map();

    for (const [key, group] of this.groups) {
      const acceptedBlock = resolutions.get(key) ?? null;
      const contents = [...group.contents.entries()].map(([contentKey, content]) => {
        const ev = evaluateReading(ledger, content.row, content.sources);
        readings.set(contentKey, ev);
        return { contentKey, row: content.row, sources: content.sources, ev };
      });
      let status = 'single';
      let effective = [];
      if (contents.length > 1) {
        const chosen = acceptedBlock
          ? contents.filter((content) =>
              content.sources.some((source) => source.block === acceptedBlock),
            )
          : [];
        if (chosen.length === 1) {
          status = 'resolved';
          effective = chosen.map((content) => content.contentKey);
        } else {
          status = 'conflict'; // 尚无裁定：两份都留档，都不可用
        }
      } else {
        effective = contents.map((content) => content.contentKey);
      }
      groups.set(key, {
        frame: group.frame,
        seq: group.seq,
        status,
        acceptedBlock,
        effective,
        contents,
      });
    }

    // 汇总到格。
    const cells = new Map();
    const ensureCell = (cell) => {
      if (!cells.has(cell)) {
        cells.set(cell, { cell, candidates: [], unusable: [], conflicted: [], rejected: [] });
      }
      return cells.get(cell);
    };
    for (const group of groups.values()) {
      for (const content of group.contents) {
        const ev = content.ev;
        if (!ev.cell) continue; // 归属完全不明，仍留在读数级待核清单里
        if (group.status === 'conflict') {
          ensureCell(ev.cell).conflicted.push(ev); // 未裁定冲突：两份都留档都不可用
        } else if (!group.effective.includes(content.contentKey)) {
          ensureCell(ev.cell).rejected.push(ev); // 裁定未采纳的一份：留档可回查，不再争议
        } else if (ev.usable) {
          ensureCell(ev.cell).candidates.push(ev);
        } else {
          ensureCell(ev.cell).unusable.push(ev);
        }
      }
    }

    // 每格选定可确认的最近测量。
    for (const cellState of cells.values()) {
      const { candidates, conflicted } = cellState;
      cellState.ambiguous = false;
      cellState.contested = false;
      cellState.chosen = null;
      if (candidates.length === 1) {
        cellState.chosen = candidates[0];
      } else if (candidates.length > 1) {
        const sorted = [...candidates].sort((a, b) => b.window.low - a.window.low);
        const top = sorted[0];
        const challenger = sorted.find(
          (other) => other !== top && other.window.high > top.window.low,
        );
        if (challenger) {
          // 先后无法判定：是否挡交接由赛道视图按结论是否改变决定。
          cellState.ambiguous = true;
          cellState.contenders = sorted.filter((other) => other.window.high >= top.window.low);
        } else {
          cellState.chosen = top;
        }
      }
      // 冲突留档的读数可能比选定证据更晚，赛道视图按结论是否改变决定。
      cellState.contested =
        Boolean(cellState.chosen) &&
        conflicted.some((ev) => ev.window && ev.window.high >= cellState.chosen.window.low);
      cellState.status = cellStatus(cellState);
    }

    const sheets = new Map();
    for (const rule of ledger.rules()) {
      sheets.set(rule.sheet, sheetStatus(rule, cells));
    }

    const alerts = handoffAlerts(ledger, groups);
    return { readings, groups, cells, sheets, alerts, rules: ledger.rules() };
  }

  // 从一份原始读数追到它曾支持哪些交接。
  readingTrace(frame, seq, ledger, certificates = []) {
    const key = `${frame}/${seq}`;
    const evaluation = this.evaluate(ledger);
    const group = evaluation.groups.get(key);
    const handoffs = ledger
      .handoffs()
      .filter((handoff) => handoff.used.some((used) => used.frame === frame && used.seq === seq))
      .map((handoff) => handoff.id);
    for (const certificate of certificates) {
      if (certificate.used.some((used) => used.frame === frame && used.seq === seq)) {
        handoffs.push(certificate.id);
      }
    }
    if (!group) return { frame, seq, known: false, handoffs };
    return {
      frame,
      seq,
      known: true,
      status: group.status,
      acceptedBlock: group.acceptedBlock,
      contents: group.contents.map((content) => ({
        row: content.row,
        sources: content.sources,
        evaluation: {
          cell: content.ev.cell,
          usable: content.ev.usable,
          reasons: content.ev.reasons,
          window: content.ev.window,
        },
      })),
      handoffs,
    };
  }
}

function evaluateReading(ledger, row, sources) {
  const ev = { row, sources, clock: null, window: null, cell: null, usable: false, reasons: [] };
  const clock = ledger.clockFor(row.frame, row.time);
  if (!clock) {
    ev.reasons.push('no-clock'); // 没有覆盖该设备时刻的校时回执
    return ev;
  }
  ev.clock = clock;
  const window = possibleWindow(row, clock);
  ev.window = window;

  const layouts = ledger
    .layoutFor(row.cal, row.frame)
    .filter((layout) => row.probe in layout.points)
    .map((layout) => ({
      layout,
      low: minutes(layout.valid[0]),
      high: minutes(layout.valid[1]),
    }));
  const containing = layouts.filter(
    (entry) => window.low >= entry.low && window.high < entry.high,
  );
  if (containing.length === 1) {
    ev.cell = containing[0].layout.points[row.probe];
  } else if (containing.length > 1) {
    ev.reasons.push('layout-duplicate');
    return ev;
  } else {
    const touched = layouts.filter((entry) =>
      overlaps(window.low, window.high, entry.low, entry.high - 1),
    );
    ev.reasons.push(touched.length > 0 ? 'layout-boundary' : 'no-layout');
    if (touched.length === 1) ev.cell = touched[0].layout.points[row.probe];
    return ev;
  }

  // 施工校验：整个可能时段须不早于该格最近一次完工；跨过完工时刻则留校时待核。
  const cell = ev.cell;
  const lastDone = ledger.lastWorkDone(cell);
  if (lastDone !== null) {
    if (window.high < lastDone) {
      const inside = ledger
        .works()
        .some(
          (work) =>
            work.region.includes(cell) &&
            overlaps(window.low, window.high, minutes(work.begins), minutes(work.done) - 1),
        );
      ev.reasons.push(inside ? 'during-work' : 'pre-work');
      return ev;
    }
    if (window.low < lastDone) {
      ev.reasons.push('work-boundary');
      return ev;
    }
  }
  ev.usable = true;
  return ev;
}

function cellStatus(cellState) {
  if (cellState.chosen) return 'ok';
  if (cellState.ambiguous) return 'ambiguous';
  if (cellState.candidates.length > 0) return 'ok';
  if (cellState.conflicted.length > 0) return 'conflict';
  if (
    cellState.unusable.some((ev) => ev.reasons.some((reason) => RESOLVABLE_REASONS.has(reason)))
  ) {
  return 'pending';
  }
  return 'missing';
}

function tempInStandard(rule, temp) {
  return temp >= rule.tempRange[0] && temp <= rule.tempRange[1];
}

function sheetStatus(rule, cells) {
  const sheet = {
    sheet: rule.sheet,
    freeze: rule.freeze,
    tempRange: rule.tempRange,
    cells: {},
    ready: true,
    missing: [],
    pending: [],
    ambiguous: [],
    outOfStandard: [],
    evidence: {},
  };
  const evidenceOf = (ev) => ({
    frame: ev.row.frame,
    seq: ev.row.seq,
    temp: ev.row.temp,
    window: ev.window,
    sources: ev.sources,
  });
  for (const cell of rule.required) {
    const state = cells.get(cell);
    if (!state || state.status === 'missing') {
      sheet.cells[cell] = 'missing';
      sheet.missing.push(cell);
      sheet.ready = false;
      continue;
    }
    if (state.status === 'pending') {
      sheet.cells[cell] = 'pending';
      sheet.pending.push(cell);
      sheet.ready = false;
      continue;
    }
    if (state.status === 'conflict') {
      sheet.cells[cell] = 'conflict';
      sheet.ambiguous.push(cell);
      sheet.ready = false;
      continue;
    }
    if (state.status === 'ambiguous') {
      // 先后无法判定：所有候选结论一致时不挡交接，否则等补证或重测。
      const verdicts = state.contenders.map((ev) => tempInStandard(rule, ev.row.temp));
      if (verdicts.every(Boolean)) {
        sheet.cells[cell] = 'ok';
        sheet.evidence[cell] = evidenceOf(state.contenders[0]);
        continue;
      }
      if (verdicts.every((verdict) => !verdict)) {
        sheet.cells[cell] = 'out-of-standard';
        sheet.outOfStandard.push(cell);
      } else {
        sheet.cells[cell] = 'ambiguous';
        sheet.ambiguous.push(cell);
      }
      sheet.ready = false;
      continue;
    }
    const chosen = state.chosen;
    if (state.contested) {
      // 冲突留档更晚且结论不同，才需要等裁定。
      const chosenIn = tempInStandard(rule, chosen.row.temp);
      const differs = state.conflicted.some(
        (ev) =>
          ev.window &&
          ev.window.high >= chosen.window.low &&
          tempInStandard(rule, ev.row.temp) !== chosenIn,
      );
      if (differs) {
        sheet.cells[cell] = 'ambiguous';
        sheet.ambiguous.push(cell);
        sheet.ready = false;
        continue;
      }
    }
    if (!tempInStandard(rule, chosen.row.temp)) {
      sheet.cells[cell] = 'out-of-standard';
      sheet.outOfStandard.push(cell);
      sheet.ready = false;
      continue;
    }
    sheet.cells[cell] = 'ok';
    sheet.evidence[cell] = evidenceOf(chosen);
  }
  return sheet;
}

// 交接后开工或源端裁定推翻原读数时，提醒赛务限制受影响范围；未受影响的照常使用。
export function alertsForHandoff(handoff, ledger, groups) {
  const alerts = [];
  const handoffAt = minutes(handoff.time);
  for (const work of ledger.works()) {
    if (minutes(work.begins) < handoffAt) continue;
    const affected = handoff.region.filter((cell) => work.region.includes(cell));
    if (affected.length > 0) {
      alerts.push({
        type: 'work-after-handoff',
        handoff: handoff.id,
        sheet: handoff.sheet,
        work: work.work,
        begins: work.begins,
        cells: affected,
      });
    }
  }
  for (const used of handoff.used) {
    const group = groups.get(`${used.frame}/${used.seq}`);
    if (!group || group.status !== 'resolved') continue;
    const accepted = group.contents.find((content) =>
      content.sources.some((source) => source.block === group.acceptedBlock),
    );
    const usedContent = group.contents.find((content) =>
      content.sources.some((source) => source.block === used.block),
    );
    if (accepted && usedContent && accepted !== usedContent) {
      alerts.push({
        type: 'reading-overturned',
        handoff: handoff.id,
        sheet: handoff.sheet,
        frame: used.frame,
        seq: used.seq,
        usedBlock: used.block,
        acceptedBlock: group.acceptedBlock,
      });
    }
  }
  return alerts;
}

function handoffAlerts(ledger, groups) {
  return ledger.handoffs().flatMap((handoff) => alertsForHandoff(handoff, ledger, groups));
}
