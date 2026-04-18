/* quiz-engine.js — randomization, scoring, timer
   ================================================================ */

const QuizEngine = (() => {

  /* ── Fisher-Yates shuffle ──────────────────────────────────── */
  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* ── Build a quiz session ──────────────────────────────────── */
  /**
   * @param {Array}  allQuestions  — flat array from all selected banks
   * @param {number|'all'} count   — how many to pick
   * @returns {Array} shuffled & trimmed question array
   */
  function buildSession(allQuestions, count) {
    // Only include questions that have answers + at least 2 options
    const valid = allQuestions.filter(q =>
      q.answer &&
      !q.answerMissing &&
      Object.keys(q.options).length >= 2
    );

    if (valid.length === 0) {
      throw new Error('No questions with verified answers found in the selected PDFs.');
    }

    const shuffled = shuffle(valid);
    if (count === 'all' || count >= shuffled.length) {
      return shuffled;
    }
    return shuffled.slice(0, count);
  }

  /* ── Timer logic ───────────────────────────────────────────── */
  let _timerInterval = null;
  let _timerCallback  = null;

  function startTimer(seconds, onTick, onExpire) {
    clearTimer();
    let remaining = seconds;
    onTick(remaining);
    _timerInterval = setInterval(() => {
      remaining--;
      onTick(remaining);
      if (remaining <= 0) {
        clearTimer();
        if (onExpire) onExpire();
      }
    }, 1000);
  }

  function clearTimer() {
    if (_timerInterval) {
      clearInterval(_timerInterval);
      _timerInterval = null;
    }
  }

  /* ── Score calculation ─────────────────────────────────────── */
  /**
   * @param {Array} questions   — session question array
   * @param {Map}   userAnswers — Map<questionId, letter>
   * @returns {{ correct, wrong, skipped, total, percentage }}
   */
  function calculateScore(questions, userAnswers) {
    let correct = 0, wrong = 0, skipped = 0;

    for (const q of questions) {
      const ua = userAnswers.get(q.id);
      if (!ua) {
        skipped++;
      } else if (ua === q.answer) {
        correct++;
      } else {
        wrong++;
      }
    }

    const total = questions.length;
    const percentage = Math.round((correct / total) * 100);

    return { correct, wrong, skipped, total, percentage };
  }

  /* ── Feedback label by score ───────────────────────────────── */
  function getFeedback(percentage) {
    if (percentage === 100) return { emoji: '🏆', text: 'Perfect Score!' };
    if (percentage >= 80)  return { emoji: '🌟', text: 'Excellent work!' };
    if (percentage >= 60)  return { emoji: '👍', text: 'Good job!' };
    if (percentage >= 40)  return { emoji: '📖', text: 'Keep studying!' };
    return                         { emoji: '💪', text: 'Never give up!' };
  }

  /* ── Score ring offset calculation ────────────────────────── */
  function getScoreArcOffset(percentage) {
    const circumference = 2 * Math.PI * 52; // r=52
    const filled        = (percentage / 100) * circumference;
    return circumference - filled;
  }

  return { shuffle, buildSession, startTimer, clearTimer, calculateScore, getFeedback, getScoreArcOffset };

})();
