// database.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./nano.db');

db.serialize(() => {
  // Messages Table
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Diary Table (NEW)
  db.run(`CREATE TABLE IF NOT EXISTS diary_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // User Stats (Updated with interaction_count)
  db.run(`CREATE TABLE IF NOT EXISTS user_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    affinity INTEGER DEFAULT 10,
    daily_changes INTEGER DEFAULT 0,
    last_update_date TEXT,
    chat_id TEXT, 
    msg_streak INTEGER DEFAULT 0,
    busy_until TEXT,
    interaction_count INTEGER DEFAULT 0 
  )`);
  
  db.run(`INSERT OR IGNORE INTO user_stats (id, affinity, daily_changes, last_update_date, msg_streak, busy_until, interaction_count) VALUES (1, 10, 0, date('now'), 0, NULL, 0)`);
});

const getTodayDate = () => new Date().toISOString().split('T')[0];

module.exports = {
  // ... (Existing functions: addMessage, getRecentHistory, searchMemory, setChatId, getLastMessage, updateStreak, setBusyUntil stay the same) ...
  
  addMessage: (role, content) => {
    return new Promise((resolve, reject) => {
      db.run('INSERT INTO messages (role, content) VALUES (?, ?)', [role, content], (err) => {
        if (err) reject(err); else resolve();
      });
    });
  },
  getRecentHistory: () => {
    return new Promise((resolve, reject) => {
      db.all('SELECT role, content, timestamp FROM messages ORDER BY id DESC LIMIT 20', (err, rows) => { 
        if (err) reject(err); else resolve(rows.reverse()); 
      });
    });
  },
  searchMemory: (keyword) => {
    return new Promise((resolve, reject) => {
      const query = `%${keyword}%`;
      db.all('SELECT role, content, timestamp FROM messages WHERE content LIKE ? ORDER BY id DESC LIMIT 5', [query], (err, rows) => {
        if (err) reject(err); else resolve(rows);
      });
    });
  },
  getAffinity: () => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM user_stats WHERE id = 1', (err, row) => {
        if (err) reject(err); else resolve(row);
      });
    });
  },
  updateAffinity: async (change) => {
    if (change === 0) return "Neutral interaction, no change.";
    const stats = await module.exports.getAffinity();
    const today = getTodayDate();
    let { affinity, daily_changes, last_update_date } = stats;

    if (last_update_date !== today) daily_changes = 0;
    if (daily_changes >= 10) return "Daily emotional change limit reached.";

    let newAffinity = affinity + change;
    if (newAffinity > 100) newAffinity = 100;
    if (newAffinity < -100) newAffinity = -100;

    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE user_stats SET affinity = ?, daily_changes = ?, last_update_date = ? WHERE id = 1`,
        [newAffinity, daily_changes + 1, today],
        (err) => {
          if (err) reject(err); else resolve(`Affinity updated. New Level: ${newAffinity}`);
        }
      );
    });
  },
  setChatId: (chatId) => {
    db.run('UPDATE user_stats SET chat_id = ? WHERE id = 1', [chatId]);
  },
  getLastMessage: () => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM messages ORDER BY id DESC LIMIT 1', (err, row) => {
        if (err) reject(err); else resolve(row);
      });
    });
  },
  updateStreak: (streak) => {
    db.run('UPDATE user_stats SET msg_streak = ? WHERE id = 1', [streak]);
  },
  setBusyUntil: (isoTimestamp) => {
    return new Promise((resolve, reject) => {
      db.run('UPDATE user_stats SET busy_until = ? WHERE id = 1', [isoTimestamp], (err) => {
         if (err) reject(err); else resolve();
      });
    });
  },

  // --- NEW DIARY FUNCTIONS ---

  incrementInteractionCount: () => {
    db.run('UPDATE user_stats SET interaction_count = interaction_count + 1 WHERE id = 1');
  },

  resetInteractionCount: () => {
    db.run('UPDATE user_stats SET interaction_count = 0 WHERE id = 1');
  },

  addDiaryEntry: (content) => {
    db.run('INSERT INTO diary_entries (content) VALUES (?)', [content]);
  },

  getRecentDiaryEntries: () => {
    return new Promise((resolve, reject) => {
      // Get last 10 entries
      db.all('SELECT content, timestamp FROM diary_entries ORDER BY id DESC LIMIT 10', (err, rows) => {
        if (err) reject(err); 
        else resolve(rows.reverse()); // Oldest to newest
      });
    });
  }
};