#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const logPath = path.join(process.cwd(), 'data', 'logs', 'performance.jsonl');
if (!fs.existsSync(logPath)) {
  console.log('No performance log yet. Run the app and trigger routes to generate data at data/logs/performance.jsonl');
  process.exit(0);
}

const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
const entries = lines.map((line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}).filter(Boolean);

if (entries.length === 0) {
  console.log('No valid performance entries found.');
  process.exit(0);
}

const byLabel = new Map();
for (const entry of entries) {
  const label = String(entry.label || 'unknown');
  const bucket = byLabel.get(label) || [];
  bucket.push(entry);
  byLabel.set(label, bucket);
}

console.log('Performance summary');
console.log('====================');
console.log(`Entries: ${entries.length}`);
console.log(`First: ${entries[0].at}`);
console.log(`Last: ${entries[entries.length - 1].at}`);
console.log('');

for (const [label, items] of [...byLabel.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const durations = items.map((item) => Number(item.durationMs || 0)).filter((n) => Number.isFinite(n));
  const heapValues = items.map((item) => Number(item.heapUsedMb || 0)).filter((n) => Number.isFinite(n));
  const avg = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0;
  const max = durations.length ? Math.max(...durations) : 0;
  const p95 = durations.length ? durations.slice().sort((a, b) => a - b)[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : 0;
  const peakHeap = heapValues.length ? Math.max(...heapValues) : 0;
  const errors = items.filter((item) => item.status === 'error').length;

  console.log(`${label}`);
  console.log(`  count=${items.length} avg=${avg.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms errors=${errors}`);
  console.log(`  peakHeap=${peakHeap.toFixed(2)}MB`);
}

const leakCandidates = entries
  .filter((item) => item.heapUsedMb != null && Number(item.heapUsedMb) > 0)
  .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

let steadilyRising = false;
for (let i = 1; i < leakCandidates.length; i += 1) {
  const prev = Number(leakCandidates[i - 1].heapUsedMb || 0);
  const curr = Number(leakCandidates[i].heapUsedMb || 0);
  if (curr > prev + 20) {
    steadilyRising = true;
    break;
  }
}

console.log('');
if (steadilyRising) {
  console.log('Memory leak risk: heap usage is trending upward significantly across samples.');
} else {
  console.log('Memory leak risk: no strong upward heap trend detected in current samples.');
}
