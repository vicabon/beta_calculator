/**
 * @fileoverview Zero-dependency, strictly XSS-safe SVG chart renderers
 * (all elements constructed via document.createElementNS — zero innerHTML).
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function clearSvg(svg) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
}

function createEl(tag, attrs = {}, text = null) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  if (text !== null) el.textContent = String(text);
  return el;
}

export function renderFireTrajectoryChart(svg, trajectory) {
  clearSvg(svg);
  if (!trajectory || trajectory.length < 2) return;

  const vals = [0];
  for (const pt of trajectory) {
    vals.push(pt.endRealBalance, pt.idealDwzBalance, pt.classicFireTarget);
  }
  const minV = Math.min(...vals);
  let maxV = Math.max(...vals);
  if (maxV === minV) maxV = minV + 1;

  const W = 640, H = 240, padL = 56, padR = 16, padT = 14, padB = 26;
  const mapX = (i) => padL + (i / (trajectory.length - 1)) * (W - padL - padR);
  const mapY = (v) => H - padB - ((v - minV) / (maxV - minV)) * (H - padT - padB);

  // Horizontal grid lines
  for (let g = 0; g <= 4; g++) {
    const val = minV + ((maxV - minV) * g) / 4;
    const y = mapY(val);
    svg.appendChild(createEl('line', { x1: padL, x2: W - padR, y1: y.toFixed(1), y2: y.toFixed(1), stroke: '#1e293b', 'stroke-width': 1 }));
    const label = Math.abs(val) >= 10000 ? `${(val / 10000).toFixed(0)}萬` : Math.round(val);
    svg.appendChild(createEl('text', { x: padL - 6, y: (y + 3).toFixed(1), fill: '#94a3b8', 'font-size': 10, 'text-anchor': 'end' }, label));
  }

  // Zero line highlight
  const zY = mapY(0);
  svg.appendChild(createEl('line', { x1: padL, x2: W - padR, y1: zY.toFixed(1), y2: zY.toFixed(1), stroke: '#475569', 'stroke-dasharray': '4,3' }));

  const addCurve = (key, color, dash, width) => {
    const pts = trajectory.map((pt, idx) => `${mapX(idx).toFixed(1)},${mapY(pt[key]).toFixed(1)}`).join(' ');
    const attrs = { fill: 'none', stroke: color, 'stroke-width': width, points: pts };
    if (dash) attrs['stroke-dasharray'] = dash;
    svg.appendChild(createEl('polyline', attrs));
  };

  addCurve('classicFireTarget', '#f59e0b', '4,4', 2);
  addCurve('idealDwzBalance', '#10b981', '7,4', 2.4);
  addCurve('endRealBalance', '#3b82f6', '', 3);

  // X-axis age labels
  const step = Math.max(1, Math.floor((trajectory.length - 1) / 5));
  for (let i = 0; i < trajectory.length; i += step) {
    svg.appendChild(createEl('text', {
      x: mapX(i).toFixed(1), y: H - 6, fill: '#94a3b8', 'font-size': 10.5, 'text-anchor': 'middle',
    }, `${trajectory[i].age}歲`));
  }
  const lastIdx = trajectory.length - 1;
  svg.appendChild(createEl('text', {
    x: mapX(lastIdx).toFixed(1), y: H - 6, fill: '#94a3b8', 'font-size': 10.5, 'text-anchor': 'end',
  }, `${trajectory[lastIdx].age}歲`));
}

export function renderBetaExposureChart(svg, holdings) {
  clearSvg(svg);
  const items = (holdings || []).filter((h) => h.marketValueTwd > 0);
  if (items.length === 0) {
    svg.appendChild(createEl('text', { x: 280, y: 110, fill: '#94a3b8', 'font-size': 13, 'text-anchor': 'middle' }, '尚無有效持倉資料'));
    return;
  }

  const W = 560, rowH = 30, padL = 82, padR = 70, padT = 14;
  const H = Math.max(210, padT + items.length * rowH + 16);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const maxWeight = Math.max(0.1, ...items.map((h) => Math.max(h.weight, Math.abs(h.weightedBetaContribution))));
  const barW = W - padL - padR;

  items.forEach((h, idx) => {
    const y = padT + idx * rowH;
    svg.appendChild(createEl('text', { x: padL - 8, y: y + 15, fill: '#e2e8f0', 'font-size': 11.5, 'font-weight': 700, 'text-anchor': 'end' }, h.ticker));

    const wLen = Math.max(2, (h.weight / maxWeight) * barW);
    svg.appendChild(createEl('rect', { x: padL, y: y + 2, width: wLen.toFixed(1), height: 9, rx: 3, fill: '#3b82f6' }));

    const bLen = Math.max(0, (Math.abs(h.weightedBetaContribution) / maxWeight) * barW);
    if (bLen > 0) {
      svg.appendChild(createEl('rect', { x: padL, y: y + 13, width: bLen.toFixed(1), height: 9, rx: 3, fill: '#10b981' }));
    }

    svg.appendChild(createEl('text', {
      x: W - 6, y: y + 15, fill: '#94a3b8', 'font-size': 10.5, 'text-anchor': 'end',
    }, `${(h.weight * 100).toFixed(1)}% / β${h.weightedBetaContribution.toFixed(2)}`));
  });
}

export function renderHistoryPriceChart(svg, rows) {
  clearSvg(svg);
  const valid = (rows || []).filter((r) => Number.isFinite(r.consensusPrice) && r.consensusPrice > 0);
  if (valid.length < 2) {
    svg.appendChild(createEl('text', { x: 320, y: 100, fill: '#94a3b8', 'font-size': 12.5, 'text-anchor': 'middle' }, '點選「開始區間追蹤」繪製多源歷史共識走勢圖'));
    return;
  }

  const prices = valid.map((r) => r.consensusPrice);
  const minP = Math.min(...prices) * 0.99;
  let maxP = Math.max(...prices) * 1.01;
  if (maxP === minP) maxP = minP + 1;

  const W = 640, H = 195, padL = 52, padR = 14, padT = 14, padB = 24;
  const mapX = (i) => padL + (i / (valid.length - 1)) * (W - padL - padR);
  const mapY = (v) => H - padB - ((v - minP) / (maxP - minP)) * (H - padT - padB);

  const pts = valid.map((r, i) => `${mapX(i).toFixed(1)},${mapY(r.consensusPrice).toFixed(1)}`).join(' ');
  svg.appendChild(createEl('polyline', { fill: 'none', stroke: '#3b82f6', 'stroke-width': 2.5, points: pts }));

  valid.forEach((r, i) => {
    if (r.statusCode === 'DISCREPANCY') {
      svg.appendChild(createEl('circle', { cx: mapX(i).toFixed(1), cy: mapY(r.consensusPrice).toFixed(1), r: 4.5, fill: '#f43f5e' }));
    }
  });

  svg.appendChild(createEl('text', { x: padL, y: H - 6, fill: '#94a3b8', 'font-size': 10.5 }, valid[0].date));
  svg.appendChild(createEl('text', { x: W - padR, y: H - 6, fill: '#94a3b8', 'font-size': 10.5, 'text-anchor': 'end' }, valid[valid.length - 1].date));
  svg.appendChild(createEl('text', { x: padL - 6, y: padT + 6, fill: '#94a3b8', 'font-size': 10, 'text-anchor': 'end' }, maxP.toFixed(1)));
  svg.appendChild(createEl('text', { x: padL - 6, y: H - padB, fill: '#94a3b8', 'font-size': 10, 'text-anchor': 'end' }, minP.toFixed(1)));
}
