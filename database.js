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

  db.run(`CREATE TABLE IF NOT EXISTS diary_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

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
  
  // Ensure default row exists
  db.run(`INSERT OR IGNORE INTO user_stats (id, affinity, daily_changes, last_update_date, msg_streak, busy_until, interaction_count) VALUES (1, 10, 0, date('now'), 0, NULL, 0)`);
});

const getTodayDate = () => new Date().toISOString().split('T')[0];

module.exports = {
  addMessage: (role, content) => {
    return new Promise((resolve, reject) => {
      db.run('INSERT INTO messages (role, content) VALUES (?, ?)', [role, content], (err) => {
        if (err) reject(err); else resolve();
      });
    });
  },
  
  // CHANGED: LIMIT 10 (Token Saver)
  getRecentHistory: () => {
    return new Promise((resolve, reject) => {
      db.all('SELECT role, content, timestamp FROM messages ORDER BY id DESC LIMIT 10', (err, rows) => { 
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

  // --- UPDATED DIARY FUNCTIONS (Now returning Promises) ---

  incrementInteractionCount: () => {
    return new Promise((resolve, reject) => {
      // Fix potential NULL values by coalescing to 0 before adding
      db.run('UPDATE user_stats SET interaction_count = IFNULL(interaction_count, 0) + 1 WHERE id = 1', (err) => {
        if (err) reject(err); else resolve();
      });
    });
  },

  resetInteractionCount: () => {
    return new Promise((resolve, reject) => {
      db.run('UPDATE user_stats SET interaction_count = 0 WHERE id = 1', (err) => {
        if (err) reject(err); else resolve();
      });
    });
  },

  addDiaryEntry: (content) => {
    db.run('INSERT INTO diary_entries (content) VALUES (?)', [content]);
  },

  // CHANGED: LIMIT 3 (Token Saver)
  getRecentDiaryEntries: () => {
    return new Promise((resolve, reject) => {
      db.all('SELECT content, timestamp FROM diary_entries ORDER BY id DESC LIMIT 5', (err, rows) => {
        if (err) reject(err); 
        else resolve(rows.reverse());
      });
    });
  }
};