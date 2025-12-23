// database.js
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./nano.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Added 'busy_until' column
  db.run(`CREATE TABLE IF NOT EXISTS user_stats (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    affinity INTEGER DEFAULT 10,
    daily_changes INTEGER DEFAULT 0,
    last_update_date TEXT,
    chat_id TEXT, 
    msg_streak INTEGER DEFAULT 0,
    busy_until TEXT 
  )`);
  
  db.run(`INSERT OR IGNORE INTO user_stats (id, affinity, daily_changes, last_update_date, msg_streak, busy_until) VALUES (1, 10, 0, date('now'), 0, NULL)`);
});

const getTodayDate = () => new Date().toISOString().split('T')[0];

module.exports = {
  // ... (Previous functions: addMessage, getRecentHistory, searchMemory, getAffinity stay the same) ...

  addMessage: (role, content) => {
    return new Promise((resolve, reject) => {
      db.run('INSERT INTO messages (role, content) VALUES (?, ?)', [role, content], (err) => {
        if (err) reject(err); else resolve();
      });
    });
  },
  getRecentHistory: () => {
    return new Promise((resolve, reject) => {
      db.all('SELECT role, content, timestamp FROM messages ORDER BY id DESC LIMIT 30', (err, rows) => { 
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

  // --- NEW FUNCTION ---
  setBusyUntil: (isoTimestamp) => {
    return new Promise((resolve, reject) => {
      db.run('UPDATE user_stats SET busy_until = ? WHERE id = 1', [isoTimestamp], (err) => {
         if (err) reject(err); else resolve();
      });
    });
  }
};