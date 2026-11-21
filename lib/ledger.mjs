// 作业台账：按到达顺序从来源分页拉取 probe / ice / referee 记录，
// 并整理成校时、缓冲边界、布点、施工、出勤窗、班组回执、赛务规则与交接凭据。
// 台账只追加，值班员交班后新进程用同一存储目录即可接着同一轮进度。

import { minutes } from './clock.mjs';

const SOURCES = ['probe', 'ice', 'referee'];

export class Ledger {
  constructor(base, fetchImpl = globalThis.fetch) {
    this.base = base;
    this.fetch = fetchImpl;
    this.records = new Map(SOURCES.map((name) => [name, []]));
    this.seen = new Set();
    this.stage = 1;
  }

  async refresh() {
    const overview = await (await this.fetch(`${this.base}/`)).json();
    this.stage = overview.stage;
    for (const name of SOURCES) {
      let offset = 0;
      do {
        const page = await (
          await this.fetch(`${this.base}/source/${name}?offset=${offset}&limit=100`)
        ).json();
        for (const entry of page.records) {
          if (this.seen.has(entry.record)) continue;
          this.seen.add(entry.record);
          this.records.get(name).push(entry);
        }
        offset = page.next;
      } while (offset !== null);
    }
    return this.stage;
  }

  // 当前生效的校时回执：带 supersedes 的回执只在自身设备时间区间内替换旧回执。
  clockFor(frame, deviceTime) {
    const device = minutes(deviceTime);
    const receipts = this.records
      .get('probe')
      .filter((entry) => entry.kind === 'clock' && entry.payload.frame === frame)
      .map((entry) => entry.payload);
    const covering = receipts.filter(
      (receipt) =>
        device >= minutes(receipt.deviceRange[0]) && device < minutes(receipt.deviceRange[1]),
    );
    if (covering.length === 0) return null;
    const replacement = covering.filter((receipt) => receipt.supersedes);
    if (replacement.length > 0) return replacement[replacement.length - 1];
    return covering[0];
  }

  // 每架最新的可恢复序号边界（端点均包含）。
  bufferBounds() {
    const bounds = new Map();
    for (const entry of this.records.get('probe')) {
      if (entry.kind !== 'buffer') continue;
      bounds.set(entry.payload.frame, entry.payload);
    }
    return bounds;
  }

  // 来源裁定：指定架和序号最终采用哪份原件。
  resolutions() {
    const map = new Map();
    for (const entry of this.records.get('probe')) {
      if (entry.kind !== 'resolution') continue;
      map.set(`${entry.payload.frame}/${entry.payload.seq}`, entry.payload.acceptedBlock);
    }
    return map;
  }

  layouts() {
    return this.records
      .get('ice')
      .filter((entry) => entry.kind === 'layout')
      .map((entry) => entry.payload);
  }

  // 布点表：校验编号 + 架号 -> 按有效时段排序的布点。
  layoutFor(cal, frame) {
    return this.layouts()
      .filter((layout) => layout.cal === cal && layout.frame === frame)
      .sort((a, b) => minutes(a.valid[0]) - minutes(b.valid[0]));
  }

  works() {
    return this.records
      .get('ice')
      .filter((entry) => entry.kind === 'work')
      .map((entry) => entry.payload);
  }

  // 影响某格的最近一次施工完工时刻（赛场时钟，完工时刻本身不含在施工区间内；无则 null）。
  // 台账记录的完工时刻即事实：读数须整段不早于它。
  lastWorkDone(cell) {
    let done = null;
    for (const work of this.works()) {
      if (!work.region.includes(cell)) continue;
      const doneAt = minutes(work.done);
      if (done === null || doneAt > done) done = doneAt;
    }
    return done;
  }

  crewWindows() {
    return this.records
      .get('ice')
      .filter((entry) => entry.kind === 'crewWindow')
      .map((entry) => entry.payload);
  }

  // 班组回执按 job 归并，保留状态时间线。
  jobs() {
    const jobs = new Map();
    for (const entry of this.records.get('ice')) {
      if (entry.kind !== 'job') continue;
      const payload = entry.payload;
      if (!jobs.has(payload.job)) jobs.set(payload.job, { id: payload.job, history: [] });
      jobs.get(payload.job).history.push(payload);
    }
    for (const job of jobs.values()) {
      job.history.sort((a, b) => minutes(a.time) - minutes(b.time));
      const last = job.history[job.history.length - 1];
      job.window = last.window;
      job.cells = last.cells;
      job.status = last.status;
    }
    return [...jobs.values()];
  }

  rules() {
    return this.records
      .get('referee')
      .filter((entry) => entry.kind === 'rule')
      .map((entry) => entry.payload);
  }

  handoffs() {
    return this.records
      .get('referee')
      .filter((entry) => entry.kind === 'handoff')
      .map((entry) => entry.payload);
  }
}
