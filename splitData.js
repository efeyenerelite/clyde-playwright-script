const fs = require('fs');
const path = require('path');

// Read the allMalformed file
const content = fs.readFileSync(path.join(__dirname, 'resources', 'allMalformed'), 'utf-8');
const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);

console.log(`Total lines: ${lines.length}`);

// Parse each line: extract RcptMaster (col 4) and InvMaster (col 1)
const rows = lines.map(line => {
  const cols = line.split('\t');
  return {
    rcptMaster: parseInt(cols[4].trim(), 10),
    invMaster: parseInt(cols[1].trim(), 10),
    line,
  };
});

// Group by RcptMaster
const rcptMap = new Map();
for (const row of rows) {
  if (!rcptMap.has(row.rcptMaster)) {
    rcptMap.set(row.rcptMaster, { invMasters: new Set(), lines: [] });
  }
  const group = rcptMap.get(row.rcptMaster);
  group.invMasters.add(row.invMaster);
  group.lines.push(row.line);
}

const rcptIds = [...rcptMap.keys()];
console.log(`Unique receipts: ${rcptIds.length}`);

// Collect all unique InvMaster values
const allInvMasters = new Set();
for (const [, group] of rcptMap) {
  for (const inv of group.invMasters) {
    allInvMasters.add(inv);
  }
}
console.log(`Unique invoices: ${allInvMasters.size}`);

// Build a graph: map each InvMaster to the receipts that use it
const invToReceipts = new Map();
for (const [rcptId, group] of rcptMap) {
  for (const inv of group.invMasters) {
    if (!invToReceipts.has(inv)) {
      invToReceipts.set(inv, []);
    }
    invToReceipts.get(inv).push(rcptId);
  }
}

// Find connected components using Union-Find
const parent = new Map();
const rank = new Map();

function find(x) {
  if (!parent.has(x)) { parent.set(x, x); rank.set(x, 0); }
  if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
  return parent.get(x);
}

function union(a, b) {
  const ra = find(a), rb = find(b);
  if (ra === rb) return;
  if (rank.get(ra) < rank.get(rb)) parent.set(ra, rb);
  else if (rank.get(ra) > rank.get(rb)) parent.set(rb, ra);
  else { parent.set(rb, ra); rank.set(ra, rank.get(ra) + 1); }
}

// Union receipts that share an invoice
for (const [, receipts] of invToReceipts) {
  for (let i = 1; i < receipts.length; i++) {
    union(receipts[0], receipts[i]);
  }
}

// Group receipts into connected components
const components = new Map();
for (const rcptId of rcptIds) {
  const root = find(rcptId);
  if (!components.has(root)) components.set(root, []);
  components.get(root).push(rcptId);
}

console.log(`Connected components: ${components.size}`);

// Sort components by their smallest receipt ID (to keep original order)
const sortedComponents = [...components.values()].sort((a, b) => Math.min(...a) - Math.min(...b));

// Print component sizes
for (const comp of sortedComponents) {
  if (comp.length > 1) {
    console.log(`  Component with ${comp.length} receipts: ${comp.sort((a,b) => a-b).join(', ')}`);
  }
}

// Split into 3 groups, trying to balance the total number of lines
const NUM_GROUPS = 3;
const groupLines = Array(NUM_GROUPS).fill(0);
const groupReceipts = Array.from({ length: NUM_GROUPS }, () => new Set());

// Sort components by total line count descending for better balancing
const compWithSize = sortedComponents.map(comp => ({
  receipts: comp.sort((a,b) => a-b),
  lineCount: comp.reduce((sum, r) => sum + rcptMap.get(r).lines.length, 0),
}));
compWithSize.sort((a, b) => b.lineCount - a.lineCount);

for (const comp of compWithSize) {
  // Find the group with the fewest lines
  let minIdx = 0;
  for (let i = 1; i < NUM_GROUPS; i++) {
    if (groupLines[i] < groupLines[minIdx]) minIdx = i;
  }
  for (const r of comp.receipts) groupReceipts[minIdx].add(r);
  groupLines[minIdx] += comp.lineCount;
}

for (let i = 0; i < NUM_GROUPS; i++) {
  console.log(`\nGroup ${i + 1}: ${groupReceipts[i].size} receipts, ${groupLines[i]} lines`);
}

// Verify no overlap in receipts and invoices between any pair
for (let i = 0; i < NUM_GROUPS; i++) {
  for (let j = i + 1; j < NUM_GROUPS; j++) {
    const rcptOverlap = [...groupReceipts[i]].filter(r => groupReceipts[j].has(r));
    console.log(`Receipt overlap (Group ${i+1} & ${j+1}): ${rcptOverlap.length}`);

    const invI = new Set(), invJ = new Set();
    for (const r of groupReceipts[i]) for (const inv of rcptMap.get(r).invMasters) invI.add(inv);
    for (const r of groupReceipts[j]) for (const inv of rcptMap.get(r).invMasters) invJ.add(inv);
    const invOverlap = [...invI].filter(inv => invJ.has(inv));
    console.log(`Invoice overlap (Group ${i+1} & ${j+1}): ${invOverlap.length}`);
  }
}

// Write the files, maintaining original order (by line position in the file)
const groupOutputs = Array.from({ length: NUM_GROUPS }, () => []);

for (const line of lines) {
  const cols = line.split('\t');
  const rcptMaster = parseInt(cols[4].trim(), 10);
  for (let i = 0; i < NUM_GROUPS; i++) {
    if (groupReceipts[i].has(rcptMaster)) {
      groupOutputs[i].push(line);
      break;
    }
  }
}

for (let i = 0; i < NUM_GROUPS; i++) {
  const fileName = `malformedData${i + 1}`;
  fs.writeFileSync(path.join(__dirname, 'resources', fileName), groupOutputs[i].join('\n') + '\n', 'utf-8');
  console.log(`\nWritten ${fileName}: ${groupOutputs[i].length} lines`);
}
console.log('Done!');
