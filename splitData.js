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

// Split into two groups, trying to balance the total number of lines
let group1Lines = 0, group2Lines = 0;
const group1Receipts = new Set(), group2Receipts = new Set();

// Sort components by total line count descending for better balancing
const compWithSize = sortedComponents.map(comp => ({
  receipts: comp.sort((a,b) => a-b),
  lineCount: comp.reduce((sum, r) => sum + rcptMap.get(r).lines.length, 0),
}));
compWithSize.sort((a, b) => b.lineCount - a.lineCount);

for (const comp of compWithSize) {
  if (group1Lines <= group2Lines) {
    for (const r of comp.receipts) group1Receipts.add(r);
    group1Lines += comp.lineCount;
  } else {
    for (const r of comp.receipts) group2Receipts.add(r);
    group2Lines += comp.lineCount;
  }
}

console.log(`\nGroup 1: ${group1Receipts.size} receipts, ${group1Lines} lines`);
console.log(`Group 2: ${group2Receipts.size} receipts, ${group2Lines} lines`);

// Verify no overlap in receipts
const rcptOverlap = [...group1Receipts].filter(r => group2Receipts.has(r));
console.log(`Receipt overlap: ${rcptOverlap.length}`);

// Verify no overlap in invoices
const group1Invoices = new Set();
const group2Invoices = new Set();
for (const r of group1Receipts) {
  for (const inv of rcptMap.get(r).invMasters) group1Invoices.add(inv);
}
for (const r of group2Receipts) {
  for (const inv of rcptMap.get(r).invMasters) group2Invoices.add(inv);
}
const invOverlap = [...group1Invoices].filter(inv => group2Invoices.has(inv));
console.log(`Invoice overlap: ${invOverlap.length}`);

// Write the two files, maintaining original order (by line position in the file)
// We need to preserve the original line order within each group
const group1Output = [];
const group2Output = [];

for (const line of lines) {
  const cols = line.split('\t');
  const rcptMaster = parseInt(cols[4].trim(), 10);
  if (group1Receipts.has(rcptMaster)) {
    group1Output.push(line);
  } else if (group2Receipts.has(rcptMaster)) {
    group2Output.push(line);
  }
}

fs.writeFileSync(path.join(__dirname, 'resources', 'malformedData1'), group1Output.join('\n') + '\n', 'utf-8');
fs.writeFileSync(path.join(__dirname, 'resources', 'malformedData2'), group2Output.join('\n') + '\n', 'utf-8');

console.log(`\nWritten malformedData1: ${group1Output.length} lines`);
console.log(`Written malformedData2: ${group2Output.length} lines`);
console.log('Done!');
