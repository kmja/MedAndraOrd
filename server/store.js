import fs from 'node:fs';
import path from 'node:path';

// Small JSON-file store with atomic writes. The interface is deliberately
// narrow so it can be swapped for a real database without touching game logic.
//
// Shape:
// {
//   names: { [playerId]: displayName },
//   days: {
//     [date]: {
//       wordIndex: number,
//       clueCache: { [normalizedClue]: verdictObject },   // fairness + cost control
//       players: { [playerId]: { attempts: number, best: number|null } }
//     }
//   }
// }

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { names: {}, days: {} };
    this._saveTimer = null;
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.data = JSON.parse(raw);
      this.data.names ??= {};
      this.data.days ??= {};
    } catch {
      // fresh store
    }
  }

  save() {
    // Debounced atomic write: tmp file + rename.
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = this.filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data));
        fs.renameSync(tmp, this.filePath);
      } catch (err) {
        console.error('store save failed:', err.message);
      }
    }, 250);
  }

  day(date, wordIndex) {
    const days = this.data.days;
    if (!days[date]) {
      days[date] = { wordIndex, clueCache: {}, players: {} };
    }
    return days[date];
  }

  player(date, wordIndex, playerId) {
    const day = this.day(date, wordIndex);
    if (!day.players[playerId]) {
      day.players[playerId] = { attempts: 0, best: null };
    }
    return day.players[playerId];
  }

  getCachedVerdict(date, wordIndex, normClue) {
    return this.day(date, wordIndex).clueCache[normClue] ?? null;
  }

  cacheVerdict(date, wordIndex, normClue, verdict) {
    this.day(date, wordIndex).clueCache[normClue] = verdict;
    this.save();
  }

  setName(playerId, name) {
    this.data.names[playerId] = name;
    this.save();
  }

  getName(playerId) {
    return this.data.names[playerId] ?? null;
  }

  /** Per-word leaderboard, computed server-side from server-recorded bests. */
  leaderboard(date, wordIndex, limit = 20) {
    const day = this.data.days[date];
    if (!day) return [];
    return Object.entries(day.players)
      .filter(([, p]) => p.best != null)
      .map(([pid, p]) => ({
        name: this.data.names[pid] || 'Anonym',
        score: p.best,
        playerId: pid,
      }))
      .sort((a, b) => a.score - b.score)
      .slice(0, limit)
      .map(({ name, score }, i) => ({ rank: i + 1, name, score }));
  }
}
