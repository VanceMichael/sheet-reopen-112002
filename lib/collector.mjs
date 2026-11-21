// 场边网关采集器：按轮取目录、用共享额度挑选最值得读的缓冲段、
// 校验摘要入库，并把进度落盘，值班员交班后新进程可接着同一轮继续做。
//
// 选读策略：
// - 先用已有原始记录和当前目录排除已完整取得的缓冲段（同内容中继去重）。
// - 缺口 = 台账缓冲边界内尚未取得内容的序号；无边界记录的架子，
//   只有在它服务的赛道仍未齐格时才值得读。
// - 优先保住仍可能填补最近交接缺口、且本轮之后过期的"独有"读数；
//   同内容被更长有效期的块覆盖时，不为即将到期花冤枉钱。
// - 连续取回都只有旧（永久不可用）读数的架子让位，避免长期占住短连。
// - 发出有效请求即耗额度，坏包也算一次；只有摘要校验有效的原件才入库。

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Ledger } from './ledger.mjs';
import { EvidenceStore, RESOLVABLE_REASONS } from './evidence.mjs';
import { minutes } from './clock.mjs';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export class Collector {
  constructor(base, options = {}) {
    this.base = base;
    this.fetch = options.fetchImpl ?? globalThis.fetch;
    this.stateFile = options.stateFile ?? null;
    this.ledger = new Ledger(base, this.fetch);
    this.store = new EvidenceStore();
    this.collected = new Set();
    this.frameStats = new Map(); // frame -> { fruitless: n }
    this.certificates = new Map(); // sheet -> 本地交接凭据（签发后不可改）
    this.stage = 1;
  }

  async load() {
    if (!this.stateFile) return;
    let state;
    try {
      state = JSON.parse(await readFile(this.stateFile, 'utf8'));
    } catch {
      return; // 首次值勤，没有既有进度
    }
    for (const [round, catalog] of Object.entries(state.catalogs ?? {})) {
      this.store.addCatalog(Number(round), catalog);
    }
    for (const [id, rows] of Object.entries(state.blocks ?? {})) {
      this.store.addBlockRows(id, rows, state.blockStages?.[id] ?? 1);
    }
    this.store.readLog.push(...(state.readLog ?? []));
    this.collected = new Set(state.collected ?? []);
    this.frameStats = new Map(Object.entries(state.frameStats ?? {}));
    this.certificates = new Map(Object.entries(state.certificates ?? {}));
  }

  async save() {
    if (!this.stateFile) return;
    const blockStages = {};
    for (const group of this.store.groups.values()) {
      for (const content of group.contents.values()) {
        for (const source of content.sources) blockStages[source.block] = source.stage;
      }
    }
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    await writeFile(
      this.stateFile,
      JSON.stringify(
        {
          catalogs: Object.fromEntries(this.store.catalogs),
          blocks: Object.fromEntries(this.store.blockRows),
          blockStages,
          readLog: this.store.readLog,
          collected: [...this.collected],
          frameStats: Object.fromEntries(this.frameStats),
          certificates: Object.fromEntries(this.certificates),
        },
        null,
        2,
      ),
    );
  }

  now() {
    const catalog = this.store.catalogs.get(this.stage);
    return catalog ? minutes(catalog.close) : null;
  }

  evaluate() {
    return this.store.evaluate(this.ledger);
  }

  // 采集当前轮：刷新台账、取目录、按计划读块。同一轮重复调用是空操作。
  async collect() {
    const stage = await this.ledger.refresh();
    this.stage = stage;
    if (this.collected.has(stage)) {
      return { stage, reads: [], skipped: true };
    }
    const catalog = await (await this.fetch(`${this.base}/gateway/catalog`)).json();
    this.store.addCatalog(stage, catalog);
    const plan = this.planReads(stage, catalog);
    const reads = [];
    for (const candidate of plan) {
      const { remaining } = await (
        await this.fetch(`${this.base}/gateway/catalog`)
      ).json();
      if (candidate.cost > remaining) continue;
      let outcome = await this.fetchBlock(stage, candidate);
      reads.push(outcome);
      if (outcome.damaged) {
        const after = await (await this.fetch(`${this.base}/gateway/catalog`)).json();
        if (candidate.cost <= after.remaining) {
          outcome = await this.fetchBlock(stage, candidate); // 坏包重试一次
          reads.push(outcome);
        }
      }
      if (outcome.status === 429) break;
    }
    this.updateFrameStats(reads);
    this.collected.add(stage);
    // 目录查询不收费：用最新剩余额度刷新本轮目录快照。
    const fresh = await (await this.fetch(`${this.base}/gateway/catalog`)).json();
    this.store.addCatalog(stage, fresh);
    this.issueCertificates();
    await this.save();
    return { stage, reads };
  }

  async fetchBlock(stage, meta) {
    const response = await this.fetch(`${this.base}/gateway/blocks/${meta.id}`);
    if (response.status !== 200) {
      return { id: meta.id, stage, status: response.status, charged: false };
    }
    const text = await response.text();
    const ok = sha256(text) === meta.sha256;
    this.store.noteRead(stage, meta.id, meta.cost, response.status, ok);
    if (!ok) {
      return { id: meta.id, stage, status: 200, charged: true, damaged: true };
    }
    const rows = JSON.parse(text);
    this.store.addBlockRows(meta.id, rows, stage);
    return { id: meta.id, stage, status: 200, charged: true, damaged: false, rows: rows.length };
  }

  // 本轮目录里值得读的块，按优先级排序。
  // 先按赛道截止先后估计"本轮额度能否把这条赛道补齐"，能就锁定所需块；
  // 补不齐的赛道不为它沉没额度；都不齐时退回（加急、赛道先后、性价比）顺序。
  planReads(stage, catalog) {
    const evaluation = this.evaluate();
    const bounds = this.ledger.bufferBounds();
    const incomplete = [...evaluation.sheets.values()]
      .filter((sheet) => !sheet.ready)
      .sort((a, b) => minutes(a.freeze) - minutes(b.freeze) || a.sheet.localeCompare(b.sheet));
    const blockingCells = (sheet) => [
      ...sheet.missing,
      ...sheet.pending,
      ...sheet.ambiguous,
      ...sheet.outOfStandard,
    ];
    const frameCells = new Map();
    for (const layout of this.ledger.layouts()) {
      if (!frameCells.has(layout.frame)) frameCells.set(layout.frame, new Set());
      for (const cell of Object.values(layout.points)) frameCells.get(layout.frame).add(cell);
    }
    const rankOf = (frame) => {
      const cells = frameCells.get(frame) ?? new Set();
      const rank = incomplete.findIndex((sheet) =>
        blockingCells(sheet).some((cell) => cells.has(cell)),
      );
      return rank === -1 ? Number.POSITIVE_INFINITY : rank;
    };

    const candidates = [];
    for (const block of catalog.blocks) {
      if (this.store.blockRows.has(block.id)) continue; // 已完整取得
      const bound = bounds.get(block.frame);
      let value = 0;
      const seqs = [];
      for (let seq = block.first; seq <= block.last; seq += 1) {
        if (this.store.groups.has(`${block.frame}/${seq}`)) continue; // 内容已在手
        if (bound) {
          if (seq < bound.oldest || seq > bound.newest) continue;
        } else if (rankOf(block.frame) === Number.POSITIVE_INFINITY) {
          continue;
        }
        value += 1;
        seqs.push(seq);
      }
      if (value === 0) continue;
      candidates.push({ ...block, value, seqs, rank: rankOf(block.frame) });
    }
    for (const candidate of candidates) {
      const others = candidates.filter((other) => other !== candidate);
      candidate.unique = candidate.seqs.filter(
        (seq) =>
          !others.some(
            (other) =>
              other.frame === candidate.frame && seq >= other.first && seq <= other.last,
          ),
      );
      candidate.urgent = candidate.expires === stage && candidate.unique.length > 0;
      candidate.fruitless = this.frameStats.get(candidate.frame)?.fruitless ?? 0;
    }
    const priorityOrder = (list) => {
      const fresh = list.filter((candidate) => candidate.fruitless < 2).sort(compareCandidates);
      const stale = list.filter((candidate) => candidate.fruitless >= 2).sort(compareCandidates);
      return [...fresh, ...stale];
    };

    const neededSeqs = (frame) => {
      const bound = bounds.get(frame);
      const seqs = new Set();
      if (bound) {
        for (let seq = bound.oldest; seq <= bound.newest; seq += 1) {
          if (!this.store.groups.has(`${frame}/${seq}`)) seqs.add(seq);
        }
      } else {
        for (const candidate of candidates) {
          if (candidate.frame === frame) for (const seq of candidate.seqs) seqs.add(seq);
        }
      }
      return [...seqs];
    };

    // 逐赛道（截止先后）做补齐估计，锁定本轮能完整交还所需的原件。
    const selected = [];
    const selectedIds = new Set();
    let budget = catalog.remaining;
    for (const sheet of incomplete) {
      const framesNeeded = new Set();
      for (const cell of blockingCells(sheet)) {
        for (const [frame, cells] of frameCells) {
          if (cells.has(cell)) framesNeeded.add(frame);
        }
      }
      const picked = [];
      let cost = 0;
      let coverable = true;
      for (const frame of framesNeeded) {
        const needed = neededSeqs(frame);
        if (needed.length === 0) continue;
        const cover = setCover(
          needed,
          candidates.filter((candidate) => candidate.frame === frame && !selectedIds.has(candidate.id)),
        );
        if (!cover) {
          coverable = false;
          break;
        }
        cost += cover.cost;
        picked.push(...cover.picked);
      }
      if (!coverable || picked.length === 0 || cost > budget) continue; // 本轮补不齐，不沉没额度
      for (const candidate of picked) {
        if (selectedIds.has(candidate.id)) continue;
        selectedIds.add(candidate.id);
        selected.push(candidate);
      }
      budget -= cost;
    }
    if (selected.length > 0) {
      const fill = priorityOrder(candidates.filter((candidate) => !selectedIds.has(candidate.id)));
      return [...selected, ...fill];
    }
    return priorityOrder(candidates);
  }

  updateFrameStats(reads) {
    const evaluation = this.evaluate();
    for (const read of reads) {
      if (!read.charged || read.damaged) continue;
      const rows = this.store.blockRows.get(read.id) ?? [];
      const stats = this.frameStats.get(rows[0]?.frame) ?? { fruitless: 0 };
      const usable = rows.some((row) => {
        const group = evaluation.groups.get(`${row.frame}/${row.seq}`);
        if (!group) return false;
        return group.effective.some((key) => evaluation.readings.get(key)?.usable);
      });
      const hopeful = rows.some((row) => {
        const group = evaluation.groups.get(`${row.frame}/${row.seq}`);
        if (!group) return false;
        return group.effective.some((key) => {
          const ev = evaluation.readings.get(key);
          return ev && ev.reasons.some((reason) => RESOLVABLE_REASONS.has(reason));
        });
      });
      if (usable) stats.fruitless = 0;
      else if (!hopeful) stats.fruitless += 1; // 取回的只有旧读数
      if (rows[0]) this.frameStats.set(rows[0].frame, stats);
    }
  }

  // 赛道就绪时签发本地交接凭据；凭据快照签发即定，后来证据变化只追加提醒。
  issueCertificates() {
    const evaluation = this.evaluate();
    const now = this.now();
    for (const sheet of evaluation.sheets.values()) {
      if (!sheet.ready || this.certificates.has(sheet.sheet)) continue;
      const used = Object.values(sheet.evidence).map((evidence) => ({
        frame: evidence.frame,
        seq: evidence.seq,
        block: evidence.sources[0].block,
      }));
      this.certificates.set(sheet.sheet, {
        id: `LOCAL-${sheet.sheet}`,
        sheet: sheet.sheet,
        region: [...evaluation.rules.find((rule) => rule.sheet === sheet.sheet).required],
        time: this.store.catalogs.get(this.stage)?.close ?? null,
        issuedAtMinutes: now,
        used,
      });
    }
    return [...this.certificates.values()];
  }

  // 额度或窗口耗尽后的续领视图：尚可续领 / 内容待核 / 已经无法追回。
  continuation() {
    const evaluation = this.evaluate();
    const stage = this.stage;
    const needed = this.neededSeqsByFrame(evaluation);
    const claimable = [];
    const seen = new Set();
    for (const [round, catalog] of this.store.catalogs) {
      if (round > stage) continue;
      for (const block of catalog.blocks) {
        if (seen.has(block.id)) continue;
        seen.add(block.id);
        if (block.expires < stage || this.store.blockRows.has(block.id)) continue;
        if (!needed.has(block.frame)) continue;
        const seqs = needed.get(block.frame);
        if (seqs !== null && ![...seqs].some((seq) => seq >= block.first && seq <= block.last)) {
          continue;
        }
        claimable.push({
          id: block.id,
          frame: block.frame,
          first: block.first,
          last: block.last,
          cost: block.cost,
          expires: block.expires,
        });
      }
    }
    const pendingReview = [];
    for (const group of evaluation.groups.values()) {
      if (group.status === 'conflict') {
        pendingReview.push({
          frame: group.frame,
          seq: group.seq,
          reason: 'conflict',
          blocks: group.contents.flatMap((content) =>
            content.sources.map((source) => source.block),
          ),
        });
        continue;
      }
      for (const key of group.effective) {
        const ev = evaluation.readings.get(key);
        if (!ev || ev.usable) continue;
        if (!ev.reasons.some((reason) => RESOLVABLE_REASONS.has(reason))) continue;
        pendingReview.push({
          frame: group.frame,
          seq: group.seq,
          reason: ev.reasons.find((reason) => RESOLVABLE_REASONS.has(reason)),
          blocks: ev.sources.map((source) => source.block),
        });
      }
    }
    return { claimable, pendingReview };
  }

  // 每架仍缺的序号：有边界记录按边界，无记录且服务未齐赛道时为 null（任何未取块都可能有用）。
  neededSeqsByFrame(evaluation) {
    const bounds = this.ledger.bufferBounds();
    const blocking = new Set(
      [...evaluation.sheets.values()]
        .filter((sheet) => !sheet.ready)
        .flatMap((sheet) => [
          ...sheet.missing,
          ...sheet.pending,
          ...sheet.ambiguous,
          ...sheet.outOfStandard,
        ]),
    );
    const framesServing = new Set();
    for (const layout of this.ledger.layouts()) {
      if (Object.values(layout.points).some((cell) => blocking.has(cell))) {
        framesServing.add(layout.frame);
      }
    }
    const needed = new Map();
    for (const frame of framesServing) {
      const bound = bounds.get(frame);
      if (!bound) {
        needed.set(frame, null);
        continue;
      }
      const gaps = new Set();
      for (let seq = bound.oldest; seq <= bound.newest; seq += 1) {
        if (!this.store.groups.has(`${frame}/${seq}`)) gaps.add(seq);
      }
      if (gaps.size > 0) needed.set(frame, gaps);
    }
    return needed;
  }
}

function compareCandidates(a, b) {
  return (
    Number(b.urgent) - Number(a.urgent) ||
    a.rank - b.rank ||
    b.value / b.cost - a.value / a.cost ||
    a.cost - b.cost ||
    a.id.localeCompare(b.id)
  );
}

// 贪心集合覆盖：用最少的候选块盖住架子仍缺的序号；盖不全返回 null。
function setCover(needed, candidates) {
  const uncovered = new Set(needed);
  const picked = [];
  let cost = 0;
  while (uncovered.size > 0) {
    let best = null;
    let bestGain = 0;
    for (const candidate of candidates) {
      if (picked.includes(candidate)) continue;
      const gain = candidate.seqs.filter((seq) => uncovered.has(seq)).length;
      if (gain === 0) continue;
      if (
        !best ||
        gain / candidate.cost > bestGain / best.cost ||
        (gain / candidate.cost === bestGain / best.cost && candidate.cost < best.cost)
      ) {
        best = candidate;
        bestGain = gain;
      }
    }
    if (!best) return null;
    picked.push(best);
    cost += best.cost;
    for (const seq of best.seqs) uncovered.delete(seq);
  }
  return { picked, cost };
}
