// What has this project spent, and on what. Run any time: `npm run spend`.

import { summary, BUDGET_INR } from './lib/spend.mjs';

const s = summary();

if (!s.calls) {
  console.log(`No spend recorded yet. Budget: Rs ${BUDGET_INR}.`);
  process.exit(0);
}

const bar = (frac, width = 40) => {
  const n = Math.min(width, Math.round(frac * width));
  return '[' + '#'.repeat(n) + '.'.repeat(width - n) + ']';
};

console.log(`\nSpend since ${s.first.slice(0, 10)} (${s.calls} calls, last ${s.last.slice(0, 16).replace('T', ' ')})\n`);
console.log(`  ${bar(s.inr / s.budget)}  Rs ${s.inr.toFixed(2)} of Rs ${s.budget}   (Rs ${s.remaining.toFixed(2)} left)\n`);

console.log('By what it was for:');
console.table(s.byLabel.map((r) => ({
  'what for': r.label, calls: r.calls,
  in: r.in, out: r.out, thinking: r.thought,
  Rs: r.inr,
})));

console.log('By model:');
console.table(s.byModel.map((r) => ({
  model: r.model, calls: r.calls,
  in: r.in, out: r.out, thinking: r.thought,
  Rs: r.inr,
})));

const thinking = s.byModel.reduce((a, r) => a + r.thought, 0);
const output = s.byModel.reduce((a, r) => a + r.out, 0);
if (thinking) {
  console.log(`Thinking tokens: ${thinking.toLocaleString()} against ${output.toLocaleString()} of real output ` +
              `(${Math.round((100 * thinking) / (thinking + output))}% of everything billed at the output rate).\n`);
}
