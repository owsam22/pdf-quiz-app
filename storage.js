/* storage.js — localStorage helpers for QuizPDF */

const STORAGE_KEY_BANKS  = 'quizpdf_banks';
const STORAGE_KEY_HISTORY = 'quizpdf_history';

const Storage = (() => {

  /* ── Question Banks ──────────────────────────────────────── */

  function getBanks() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_BANKS) || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveBank(bank) {
    // bank = { id, name, questions: [...], addedAt }
    const banks = getBanks();
    const idx = banks.findIndex(b => b.id === bank.id);
    if (idx >= 0) {
      banks[idx] = bank;            // update existing
    } else {
      banks.push(bank);             // add new
    }
    try {
      localStorage.setItem(STORAGE_KEY_BANKS, JSON.stringify(banks));
      return true;
    } catch (e) {
      // localStorage quota exceeded — try clearing history first
      try {
        localStorage.removeItem(STORAGE_KEY_HISTORY);
        localStorage.setItem(STORAGE_KEY_BANKS, JSON.stringify(banks));
        return true;
      } catch (e2) {
        console.error('Storage full:', e2);
        return false;
      }
    }
  }

  function removeBank(bankId) {
    const banks = getBanks().filter(b => b.id !== bankId);
    localStorage.setItem(STORAGE_KEY_BANKS, JSON.stringify(banks));
  }

  function clearBanks() {
    localStorage.removeItem(STORAGE_KEY_BANKS);
  }

  /* ── Quiz History ────────────────────────────────────────── */

  function getHistory() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY_HISTORY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveHistory(entry) {
    // entry = { date, score, total, sources, percentage }
    const history = getHistory();
    history.unshift(entry);
    const trimmed = history.slice(0, 50); // keep last 50
    try {
      localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(trimmed));
    } catch (e) {
      // ignore quota issue for history
    }
  }

  function clearHistory() {
    localStorage.removeItem(STORAGE_KEY_HISTORY);
  }

  /* ── Utilities ───────────────────────────────────────────── */

  function generateId(name) {
    return name.replace(/\W+/g, '_').toLowerCase() + '_' + Date.now();
  }

  return { getBanks, saveBank, removeBank, clearBanks, getHistory, saveHistory, clearHistory, generateId };

})();
