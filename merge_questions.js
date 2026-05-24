// Merge seed questions.json with _questions_drafts/tier_N.json files
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SEED_PATH = path.join(ROOT, 'questions.json');
const DRAFTS_DIR = path.join(ROOT, '_questions_drafts');

function validateQuestion(q, tierKey) {
  const errs = [];
  if (typeof q.id !== 'string' || !q.id) errs.push('bad id');
  if (typeof q.q !== 'string' || !q.q.trim()) errs.push('bad q');
  if (!Array.isArray(q.choices) || q.choices.length !== 4) errs.push('need 4 choices');
  if (q.choices && q.choices.some(c => typeof c !== 'string' || !c.trim())) errs.push('bad choice text');
  if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct > 3) errs.push('bad correct');
  return errs;
}

const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf-8'));
const merged = {};
const stats = {};

for (let t = 1; t <= 10; t++) {
  const key = `tier${t}`;
  const draftFile = path.join(DRAFTS_DIR, `tier_${t}.json`);
  const out = [];
  const seenIds = new Set();
  let seedCount = 0, draftCount = 0, skipped = 0;

  // Seed first (seed wins on ID conflict)
  for (const q of (seed[key] || [])) {
    const errs = validateQuestion(q, key);
    if (errs.length) { skipped++; continue; }
    if (seenIds.has(q.id)) { skipped++; continue; }
    seenIds.add(q.id);
    out.push(q);
    seedCount++;
  }

  // Draft
  if (fs.existsSync(draftFile)) {
    let draft;
    try {
      draft = JSON.parse(fs.readFileSync(draftFile, 'utf-8'));
    } catch (e) {
      console.error(`Tier ${t}: JSON parse error — ${e.message}`);
      stats[key] = { seed: seedCount, draft: 0, skipped, total: seedCount, error: e.message };
      merged[key] = out;
      continue;
    }
    if (!Array.isArray(draft)) {
      console.error(`Tier ${t}: draft is not an array`);
      stats[key] = { seed: seedCount, draft: 0, skipped, total: seedCount, error: 'not an array' };
      merged[key] = out;
      continue;
    }
    for (const q of draft) {
      const errs = validateQuestion(q, key);
      if (errs.length) { skipped++; continue; }
      if (seenIds.has(q.id)) { skipped++; continue; }
      seenIds.add(q.id);
      out.push(q);
      draftCount++;
    }
  }

  merged[key] = out;
  stats[key] = { seed: seedCount, draft: draftCount, skipped, total: out.length };
}

// Backup seed
const backupPath = path.join(ROOT, 'questions.seed.json');
if (!fs.existsSync(backupPath)) {
  fs.copyFileSync(SEED_PATH, backupPath);
  console.log(`Backed up seed -> questions.seed.json`);
}

fs.writeFileSync(SEED_PATH, JSON.stringify(merged, null, 2));

console.log('\nMerge complete:');
let grand = 0;
for (let t = 1; t <= 10; t++) {
  const s = stats[`tier${t}`];
  grand += s.total;
  const tag = s.error ? `  ERROR: ${s.error}` : '';
  console.log(`  Tier ${String(t).padStart(2)}: ${String(s.total).padStart(3)} (seed=${s.seed}, draft=${s.draft}, skipped=${s.skipped})${tag}`);
}
console.log(`  TOTAL: ${grand} questions`);
