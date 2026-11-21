// 赛场时钟与设备时钟的换算。所有时刻都是同日 "HH:MM"，内部统一折算成分钟数。

export function minutes(text) {
  const match = /^(\d{2}):(\d{2})$/.exec(text);
  if (!match) throw new Error(`无效时刻: ${text}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function clockText(value) {
  const hours = Math.floor(value / 60);
  const mins = value - hours * 60;
  return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

// 设备读数的可能赛场时段：设备时刻加上校时回执给出的两个误差端点（闭区间）。
export function possibleWindow(row, clock) {
  const device = minutes(row.time);
  return {
    low: device + clock.shiftMinutes[0],
    high: device + clock.shiftMinutes[1],
  };
}

export function overlaps(aLow, aHigh, bLow, bHigh) {
  return aLow <= bHigh && bLow <= aHigh;
}
