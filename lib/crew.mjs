// 补测安排：当最近一场的读数永久缺失、超出赛务标准或来不及确认时，
// 比较"仍能在交接前取得的电子记录"与"可用的补测时段"，给出可以领用的安排。
//
// 规则：
// - 出勤窗、获准进入的格子、每趟容量都由作业台账给出；每格测量占一格容量。
// - 同一格同时挡住两条赛道时只占一项现场工作。
// - 测量必须落在该格最近一次施工完工之后、赛道交接截止之前，且出勤窗尚未过去。
// - 优先保住最早仍有机会完整交还的赛道；赶不上交接的赛道不占用留给别人的出勤窗。
// - 班组接单后只有确认释放才能另派；读数后来足够时提示可以取消，未释放前仍占容量。
// - 施工提前或扩大时，接单中的补测重新解释适用范围。

import { minutes, clockText } from './clock.mjs';

export function planMakeup(ledger, evaluation, store, stage, now) {
  const sheets = [...evaluation.sheets.values()].sort(
    (a, b) => minutes(a.freeze) - minutes(b.freeze),
  );
  const jobs = ledger.jobs();
  const windows = ledger.crewWindows().map((window) => ({
    ...window,
    open: minutes(window.windowTime[0]),
    shut: minutes(window.windowTime[1]),
  }));

  // 出勤窗被接单占用的容量（released 才释放；cancelRequested 仍占着）。
  const occupancy = new Map(windows.map((window) => [window.window, 0]));
  const jobNotes = [];
  for (const job of jobs) {
    if (job.status === 'released') {
      jobNotes.push({ job: job.id, window: job.window, status: 'released', note: '已释放，出勤窗可另派' });
      continue;
    }
    const window = windows.find((entry) => entry.window === job.window);
    const used = Math.min(job.cells.length, window?.capacity ?? job.cells.length);
    occupancy.set(job.window, (occupancy.get(job.window) ?? 0) + used);
    // 施工提前或扩大后重新解释适用范围：窗内还能测出有效读数的格。
    const applicable = window
      ? job.cells.filter((cell) => {
          const lastDone = ledger.lastWorkDone(cell);
          return (lastDone === null || window.open >= lastDone) && window.shut > now;
        })
      : [];
    const covered = job.cells.filter((cell) => {
      const state = evaluation.cells.get(cell);
      return state?.chosen;
    });
    const cancelRecommended = applicable.length === 0 || covered.length === job.cells.length;
    jobNotes.push({
      job: job.id,
      window: job.window,
      status: job.status,
      cells: job.cells,
      applicable,
      cancelRecommended,
      note: cancelRecommended
        ? '读数已足够或窗内已测不出有效读数，建议确认取消；未释放前仍占这趟出勤'
        : '仍在占用出勤窗',
    });
  }

  // 逐格任务：同一格挡住多条赛道只占一项。
  const tasks = new Map();
  for (const sheet of sheets) {
    if (sheet.ready) continue;
    const blocking = [
      ...sheet.missing,
      ...sheet.pending,
      ...sheet.ambiguous,
      ...sheet.outOfStandard,
    ];
    for (const cell of blocking) {
      if (!tasks.has(cell)) {
        const state = evaluation.cells.get(cell);
        tasks.set(cell, {
          cell,
          sheets: [],
          status: state?.status ?? 'missing',
          lastDone: ledger.lastWorkDone(cell),
          electronic: electronicOutlook(cell, state, store, stage, ledger),
        });
      }
      tasks.get(cell).sheets.push(sheet.sheet);
    }
  }

  // 逐赛道按截止先后尝试保住；保不住就回滚它占的窗，把窗让给后面的赛道。
  const assignments = new Map(); // cell -> window
  const savedSheets = [];
  const lostSheets = [];
  const spare = new Map(
    windows.map((window) => [
      window.window,
      window.capacity - (occupancy.get(window.window) ?? 0),
    ]),
  );
  const feasible = (task, sheet, window) =>
    window.cells.includes(task.cell) &&
    (task.lastDone === null || window.open >= task.lastDone) &&
    window.shut <= minutes(sheet.freeze) &&
    window.shut > now &&
    (spare.get(window.window) ?? 0) > 0;

  for (const sheet of sheets) {
    if (sheet.ready) continue;
    const needed = [...sheet.missing, ...sheet.pending, ...sheet.ambiguous, ...sheet.outOfStandard]
      .map((cell) => tasks.get(cell))
      .filter((task) => task && !assignments.has(task.cell));
    const tentative = [];
    let failed = null;
    for (const task of needed) {
      const options = windows
        .filter((window) => feasible(task, sheet, window))
        .sort((a, b) => a.shut - b.shut || a.window.localeCompare(b.window));
      if (options.length === 0) {
        failed = task;
        break;
      }
      const window = options[0];
      spare.set(window.window, spare.get(window.window) - 1);
      tentative.push([task.cell, window]);
      assignments.set(task.cell, window);
    }
    if (failed) {
      for (const [cell, window] of tentative) {
        assignments.delete(cell);
        spare.set(window.window, spare.get(window.window) + 1);
      }
      lostSheets.push({
        sheet: sheet.sheet,
        freeze: sheet.freeze,
        cell: failed.cell,
        reason: infeasibleReason(failed, sheet, windows, now),
      });
    } else {
      savedSheets.push(sheet.sheet);
    }
  }

  const taskList = [...tasks.values()].map((task) => {
    const window = assignments.get(task.cell);
    return {
      ...task,
      lastDone: task.lastDone === null ? null : clockText(task.lastDone),
      window: window ? window.window : null,
      windowTime: window ? window.windowTime : null,
      crew: window ? window.crew : null,
      schedulable: Boolean(window),
    };
  });

  return {
    stage,
    tasks: taskList,
    assignments: [...assignments.entries()].map(([cell, window]) => ({
      cell,
      window: window.window,
      crew: window.crew,
      windowTime: window.windowTime,
    })),
    jobs: jobNotes,
    savedSheets,
    lostSheets,
    note: '同一交接时刻下保住更多完整赛道优先；并列时给出任一可行安排（按窗结束最早、窗号字典序选择）',
  };
}

// 当前目录中仍能在交接前取得的电子记录：只能说明还可能补齐，不能作为交接依据。
function electronicOutlook(cell, state, store, stage, ledger) {
  const pending = (state?.unusable ?? [])
    .filter((ev) => ev.reasons.some((reason) => reason === 'layout-boundary' || reason === 'work-boundary'))
    .map((ev) => ({ frame: ev.row.frame, seq: ev.row.seq, reasons: ev.reasons }));
  const serving = new Set(
    ledger
      .layouts()
      .filter((layout) => Object.values(layout.points).includes(cell))
      .map((layout) => layout.frame),
  );
  const fetchable = [];
  for (const [round, catalog] of store.catalogs) {
    if (round > stage) continue;
    for (const block of catalog.blocks) {
      if (block.expires < stage || store.blockRows.has(block.id)) continue;
      if (!serving.has(block.frame)) continue;
      fetchable.push({ id: block.id, frame: block.frame, first: block.first, last: block.last, expires: block.expires });
    }
  }
  return { pending, fetchable };
}

function infeasibleReason(task, sheet, windows, now) {
  const covering = windows.filter((window) => window.cells.includes(task.cell));
  if (covering.length === 0) return '没有获准进入该格的出勤窗';
  if (task.lastDone !== null && !covering.some((window) => window.open >= task.lastDone)) {
    return `该格 ${clockText(task.lastDone)} 才完工，之后没有覆盖它的出勤窗`;
  }
  if (!covering.some((window) => window.shut <= minutes(sheet.freeze))) {
    return `覆盖该格的出勤窗都晚于交接截止 ${sheet.freeze}`;
  }
  if (!covering.some((window) => window.shut > now)) return '覆盖该格的出勤窗都已过去';
  return '出勤窗容量已被确认中的工单占满';
}
