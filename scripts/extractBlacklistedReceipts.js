const fs = require('fs');
const path = require('path');

const resourcesDir = path.join(__dirname, '..', 'resources');
const receiptSet = new Set();

// Get all blackList files (including the base one)
const blackListFiles = fs.readdirSync(resourcesDir)
  .filter(f => f === 'blackList' || f.startsWith('blackList_'));

for (const file of blackListFiles) {
  const filePath = path.join(resourcesDir, file);
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    // Format 1 (newer): # Receipt 5369791 — ...
    const headerMatch = line.match(/^# Receipt (\d+)/);
    if (headerMatch) {
      receiptSet.add(headerMatch[1]);
      continue;
    }

    // Format 2 (older blackList): lines starting with a receipt index followed by a message
    // e.g. "5347811 Matter does not allow..." or "5442950 (12 Invoice)"
    const oldFormatMatch = line.match(/^(\d{5,}) .+/);
    if (oldFormatMatch) {
      // Make sure it's NOT a tab-separated data line (those start with ARMIndex which is 8 digits)
      if (line.includes('\t')) {
        // It's a data line — extract receipt index from column 5 (index 4)
        const cols = line.split('\t');
        if (cols.length >= 5 && /^\d+$/.test(cols[4])) {
          receiptSet.add(cols[4]);
        }
      } else {
        // It's a receipt-level message line — the leading number is the receipt index
        receiptSet.add(oldFormatMatch[1]);
      }
      continue;
    }

    // Tab-separated data lines that don't start matching the old format pattern
    if (line.includes('\t')) {
      const cols = line.split('\t');
      if (cols.length >= 5 && /^\d+$/.test(cols[4])) {
        receiptSet.add(cols[4]);
      }
    }
  }
}

const sorted = [...receiptSet].sort((a, b) => Number(a) - Number(b));

const outputPath = path.join(resourcesDir, 'allBlacklistedReceipts.txt');
fs.writeFileSync(outputPath, sorted.join('\n') + '\n', 'utf-8');

console.log(`Scanned ${blackListFiles.length} blacklist files:`);
blackListFiles.forEach(f => console.log(`  - ${f}`));
console.log(`\nFound ${sorted.length} distinct blacklisted receipt indexes.`);
console.log(`Written to: ${outputPath}`);
