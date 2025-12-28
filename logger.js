// logger.js
const fs = require('fs');
const path = './debug_log.txt';
const MAX_ENTRIES = 30;
const SEPARATOR = '\n==================================================\n';

function logDebug(type, content) {
  try {
    const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0];
    // Format objects nicely, leave strings as is
    const formattedContent = typeof content === 'object' 
      ? JSON.stringify(content, null, 2) 
      : content;

    const newEntry = `[${timestamp}] [${type}]\n${formattedContent}`;

    // 1. Read existing file
    let fileContent = "";
    if (fs.existsSync(path)) {
      fileContent = fs.readFileSync(path, 'utf8');
    }

    // 2. Split by separator to get array of entries
    // We filter out empty strings in case of trailing separators
    let entries = fileContent.split(SEPARATOR).filter(e => e.trim().length > 0);

    // 3. Add new entry
    entries.push(newEntry);

    // 4. Prune (Keep only last 30)
    if (entries.length > MAX_ENTRIES) {
      entries = entries.slice(-MAX_ENTRIES);
    }

    // 5. Write back to file
    // Join with separator and add one at the end for the next write
    fs.writeFileSync(path, entries.join(SEPARATOR) + SEPARATOR);

  } catch (err) {
    console.error("Logger Error:", err);
  }
}

module.exports = { logDebug };