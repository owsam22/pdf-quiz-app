/* app.js — Main controller / view router for QuizPDF
   ================================================================ */

const app = (() => {

  /* ── State ─────────────────────────────────────────────────── */
  const state = {
    banks:          [],       // all loaded question banks
    sessionQuestions: [],     // current quiz questions array
    currentIdx:     0,
    userAnswers:    new Map(),// questionId → letter chosen
    answered:       false,    // has the user answered current question?
    quizConfig: {
      selectedBankIds: new Set(),
      count:    'all',
      timer:    false,
      timerSecs: 60,
    },
    timerActive:    false,
  };

  /* ── DOM refs ──────────────────────────────────────────────── */
  const $ = id => document.getElementById(id);

  /* ── View Router ───────────────────────────────────────────── */
  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const view = document.getElementById(`view-${name}`);
    if (view) view.classList.add('active');

    // Show/hide nav buttons based on view
    const onHome = name === 'upload';
    $('navHomeBtn').style.display    = onHome ? 'none' : '';
    $('navHistoryBtn').style.display = 'none'; // history not in this build
  }

  /* ── Toast ─────────────────────────────────────────────────── */
  let _toastTimer = null;
  function toast(msg, type = 'info', duration = 3000) {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast ${type} show`;
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.classList.remove('show'); }, duration);
  }

  /* ── Processing Overlay ─────────────────────────────────────── */
  function showProcessing(text, sub = '', pct = 0) {
    $('processingOverlay').style.display = 'flex';
    $('processingText').textContent      = text;
    $('processingSubText').textContent   = sub;
    $('processingFill').style.width      = `${pct}%`;
  }
  function updateProcessing(text, sub, pct) {
    if (text !== undefined) $('processingText').textContent    = text;
    if (sub  !== undefined) $('processingSubText').textContent = sub;
    if (pct  !== undefined) $('processingFill').style.width    = `${pct}%`;
  }
  function hideProcessing() {
    $('processingOverlay').style.display = 'none';
  }

  /* ═══════════════════════════════════════════════════════════
     UPLOAD VIEW
     ═══════════════════════════════════════════════════════════ */

  function initUploadZone() {
    const zone = $('uploadZone');
    const fileInput = $('fileInput');

    // Click triggers file picker
    zone.addEventListener('click', (e) => {
      if (e.target.closest('.btn')) return; // button handles its own click
      fileInput.click();
    });

    // File picker change
    fileInput.addEventListener('change', (e) => {
      handleFiles(Array.from(e.target.files));
      fileInput.value = ''; // reset so same file can be re-uploaded
    });

    // Drag-and-drop
    zone.addEventListener('dragover',  (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', ()  => zone.classList.remove('drag-over'));
    zone.addEventListener('drop',      (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
      if (files.length) handleFiles(files);
      else toast('❌ Please drop PDF files only', 'error');
    });
  }

  async function handleFiles(files) {
    const pdfFiles = files.filter(f => f.name.toLowerCase().endsWith('.pdf'));
    if (!pdfFiles.length) { toast('❌ No PDF files selected', 'error'); return; }

    for (const file of pdfFiles) {
      await processPDF(file, file.name);
    }
  }

  async function loadFromUrl() {
    const raw = $('driveUrlInput').value.trim();
    if (!raw) { toast('Please paste a Google Drive URL', 'error'); return; }

    let url = raw;
    if (raw.includes('drive.google.com')) {
      url = PDFParser.convertDriveUrl(raw);
      toast('🔗 Converted Drive link → direct download URL', 'info');
    }

    const name = extractNameFromUrl(url);
    await processPDF(url, name);
  }

  function extractNameFromUrl(url) {
    try {
      const u = new URL(url);
      const segments = u.pathname.split('/').filter(Boolean);
      const last = segments[segments.length - 1];
      if (last && last !== 'view' && last !== 'download') return last;
      const id = u.searchParams.get('id') || 'Drive_PDF';
      return `drive_${id.slice(0, 8)}`;
    } catch (e) {
      return 'uploaded_pdf';
    }
  }

  async function processPDF(source, name) {
    const displayName = name.replace(/\.pdf$/i, '');

    // Check if already loaded
    if (state.banks.find(b => b.name === displayName)) {
      toast(`"${displayName}" is already in your bank`, 'info');
      return;
    }

    showProcessing(`📄 Loading "${displayName}"…`, 'Extracting text from pages…', 5);

    try {
      const { questions, warnings } = await PDFParser.parse(
        source,
        displayName,
        (page, total) => {
          const pct = Math.round((page / total) * 80);
          updateProcessing(
            `📄 Processing page ${page} of ${total}…`,
            `Extracting text from "${displayName}"`,
            pct
          );
        }
      );

      updateProcessing('🧠 Parsing questions…', 'Matching questions with answer key…', 85);

      await delay(200);

      if (questions.length === 0) {
        hideProcessing();
        toast(`❌ No questions found in "${displayName}". Is the PDF in the expected format?`, 'error', 5000);
        return;
      }

      updateProcessing('💾 Saving to library…', '', 95);
      await delay(100);

      const bank = {
        id:        Storage.generateId(displayName),
        name:      displayName,
        questions: questions,
        addedAt:   new Date().toISOString(),
        warnings:  warnings,
      };

      const saved = Storage.saveBank(bank);
      state.banks = Storage.getBanks();

      hideProcessing();
      renderLibrary();

      const warnMsg = warnings > 0 ? ` (${warnings} questions without verified answers are excluded from quizzes)` : '';
      const validCount = questions.filter(q => q.answer && !q.answerMissing).length;
      toast(`✅ Loaded "${displayName}": ${validCount} quiz-ready questions${warnMsg}`, 'success', 4000);

      if (!saved) {
        toast('⚠️ Storage limit reached. Some data may not be saved.', 'error', 5000);
      }

    } catch (err) {
      hideProcessing();
      console.error('[QuizPDF] Parse error:', err);
      const msg = err.message || 'Unknown error';

      if (msg.toLowerCase().includes('cors') || msg.toLowerCase().includes('fetch') || msg.toLowerCase().includes('network')) {
        toast('❌ Could not load from URL. CORS blocked. Please download the PDF and upload it directly.', 'error', 6000);
      } else {
        toast(`❌ Failed to parse PDF: ${msg}`, 'error', 5000);
      }
    }
  }

  function renderLibrary() {
    const lib     = $('pdfLibrary');
    const section = $('librarySection');
    const stats   = $('libraryStats');

    if (!state.banks.length) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';

    const totalQ = state.banks.reduce((s, b) => {
      return s + b.questions.filter(q => q.answer && !q.answerMissing).length;
    }, 0);
    stats.textContent = `${state.banks.length} PDF${state.banks.length > 1 ? 's' : ''} · ${totalQ} questions`;

    lib.innerHTML = state.banks.map(bank => {
      const validQ = bank.questions.filter(q => q.answer && !q.answerMissing).length;
      const total  = bank.questions.length;
      const pct    = total > 0 ? Math.round((validQ / total) * 100) : 0;
      return `
        <div class="pdf-card" id="bank_${bank.id}">
          <button class="pdf-card-remove" onclick="app.removeBank('${bank.id}')">✕</button>
          <div class="pdf-card-icon">📄</div>
          <div class="pdf-card-name">${escHtml(bank.name)}</div>
          <div class="pdf-card-count">✅ ${validQ} quiz-ready questions</div>
          ${bank.warnings > 0 ? `<div class="pdf-card-status">⚠️ ${bank.warnings} missing answers (excluded)</div>` : ''}
          <div class="pdf-card-progress">
            <div class="pdf-card-progress-fill" style="width:${pct}%"></div>
          </div>
        </div>
      `;
    }).join('');
  }

  function removeBank(bankId) {
    Storage.removeBank(bankId);
    state.banks = Storage.getBanks();
    renderLibrary();
    toast('Removed from library', 'info');
  }

  function clearLibrary() {
    if (!confirm('Clear all PDFs from your library?')) return;
    Storage.clearBanks();
    state.banks = [];
    renderLibrary();
    toast('Library cleared', 'info');
  }

  /* ═══════════════════════════════════════════════════════════
     CONFIG VIEW
     ═══════════════════════════════════════════════════════════ */

  function showConfig() {
    if (!state.banks.length) { toast('Upload at least one PDF first!', 'error'); return; }

    // Default: select all banks
    state.quizConfig.selectedBankIds = new Set(state.banks.map(b => b.id));
    renderConfigPDFs();
    showView('config');
  }

  function renderConfigPDFs() {
    const grid = $('pdfSelectGrid');
    grid.innerHTML = state.banks.map(bank => {
      const validQ   = bank.questions.filter(q => q.answer && !q.answerMissing).length;
      const selected = state.quizConfig.selectedBankIds.has(bank.id);
      return `
        <label class="pdf-check-item ${selected ? 'selected' : ''}" id="chk_wrap_${bank.id}">
          <input type="checkbox" id="chk_${bank.id}" ${selected ? 'checked' : ''}
            onchange="app.toggleBankSelect('${bank.id}', this.checked)" />
          <div>
            <div class="pdf-check-name">${escHtml(bank.name)}</div>
            <div class="pdf-check-count">${validQ} questions</div>
          </div>
        </label>
      `;
    }).join('');
  }

  function toggleBankSelect(bankId, checked) {
    if (checked) state.quizConfig.selectedBankIds.add(bankId);
    else         state.quizConfig.selectedBankIds.delete(bankId);
    // Update styling
    const wrap = $(`chk_wrap_${bankId}`);
    if (wrap) wrap.classList.toggle('selected', checked);
  }

  function selectAllPdfs(select = true) {
    state.banks.forEach(b => {
      state.quizConfig.selectedBankIds[select ? 'add' : 'delete'](b.id);
      const cb   = $(`chk_${b.id}`);
      const wrap = $(`chk_wrap_${b.id}`);
      if (cb)   cb.checked = select;
      if (wrap) wrap.classList.toggle('selected', select);
    });
  }

  function setCount(val, el) {
    state.quizConfig.count = val;
    document.querySelectorAll('#countChips .chip').forEach(c => c.classList.remove('active'));
    if (el) el.classList.add('active');
    if (val !== 'all') $('customCount').value = '';
  }

  function setTimerSecs(secs, el) {
    state.quizConfig.timerSecs = secs;
    document.querySelectorAll('#timerChips .chip').forEach(c => c.classList.remove('active'));
    if (el) el.classList.add('active');
  }

  let _timerOn = false;
  function toggleTimer() {
    _timerOn = !_timerOn;
    state.quizConfig.timer = _timerOn;
    const track = $('timerToggle');
    track.classList.toggle('on', _timerOn);
    $('timerToggleLabel').textContent = _timerOn ? 'Enabled' : 'Disabled';
    $('timerChips').style.display = _timerOn ? 'flex' : 'none';
  }

  function beginQuiz() {
    // Resolve question count
    const customVal = $('customCount').value.trim();
    let count = state.quizConfig.count;
    if (customVal && !isNaN(parseInt(customVal))) {
      count = parseInt(customVal);
    }

    if (!state.quizConfig.selectedBankIds.size) {
      toast('Select at least one PDF!', 'error'); return;
    }

    // Gather questions from selected banks
    const allQ = [];
    for (const id of state.quizConfig.selectedBankIds) {
      const bank = state.banks.find(b => b.id === id);
      if (bank) allQ.push(...bank.questions);
    }

    try {
      const session = QuizEngine.buildSession(allQ, count);
      startQuiz(session);
    } catch (e) {
      toast(`❌ ${e.message}`, 'error', 4000);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     QUIZ VIEW
     ═══════════════════════════════════════════════════════════ */

  function startQuiz(questions) {
    state.sessionQuestions = questions;
    state.currentIdx = 0;
    state.userAnswers = new Map();
    state.answered = false;
    showView('quiz');
    renderQuestion();
  }

  function renderQuestion() {
    QuizEngine.clearTimer();

    const idx = state.currentIdx;
    const q   = state.sessionQuestions[idx];
    const total = state.sessionQuestions.length;

    // Update bar
    $('quizProgLabel').textContent = `${idx + 1} / ${total}`;
    $('quizSourceBadge').textContent = q.source;

    // Progress fill
    const pct = ((idx) / total) * 100;
    $('quizProgressFill').style.width = `${pct}%`;

    // Card
    // Card
    $('qNumber').textContent   = `Q ${idx + 1}`;
    
    // Improved Tag: Show Type + Source?
    const type = q.type || 'MCQ';
    $('qTypeBadge').innerHTML = `<span>🏷️</span> ${type}`;
    $('qTypeBadge').style.display = 'inline-flex';
    
    $('qText').textContent     = q.question;

    // Options
    const optList = $('optionsList');
    optList.innerHTML = '';
    const letters = Object.keys(q.options).sort();
    const userChoice = state.userAnswers.get(q.id);
    const alreadyAnswered = !!userChoice;

    letters.forEach(letter => {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.dataset.letter = letter;

      if (alreadyAnswered) {
        btn.disabled = true;
        const isCorrect = letter.toLowerCase() === q.answer.toLowerCase();
        const isUserChoice = letter.toLowerCase() === userChoice.toLowerCase();

        if (isCorrect) {
          btn.classList.add('correct');
        } else if (isUserChoice) {
          btn.classList.add('wrong');
        }
      } else if (userChoice && letter.toLowerCase() === userChoice.toLowerCase()) {
        btn.classList.add('selected');
      }

      btn.innerHTML = `
        <span class="option-letter">${letter.toUpperCase()}</span>
        <span class="option-text">${escHtml(q.options[letter])}</span>
      `;
      btn.addEventListener('click', () => selectOption(letter));
      optList.appendChild(btn);
    });

    // Nav buttons
    $('prevBtn').style.display = idx > 0 ? '' : 'none';
    $('nextBtn').textContent   = idx === total - 1 ? 'Finish 🏁' : 'Next →';
    $('skipNote').textContent  = alreadyAnswered ? '' : 'Click an answer to select it, then press Next';

    state.answered = alreadyAnswered;

    // Timer
    if (state.quizConfig.timer) {
      const timerEl = $('quizTimer');
      timerEl.style.display = '';
      if (!alreadyAnswered) {
        QuizEngine.startTimer(
          state.quizConfig.timerSecs,
          (rem) => {
            $('timerVal').textContent = rem;
            timerEl.classList.toggle('warning', rem <= 10);
          },
          () => {
            // Auto-skip on expire (no correct mark)
            toast('⏰ Time up! Moving on…', 'error', 1500);
            setTimeout(() => nextQ(), 1500);
          }
        );
      } else {
        $('timerVal').textContent = '—';
      }
    } else {
      $('quizTimer').style.display = 'none';
    }
  }

  function selectOption(letter) {
    if (state.answered) return;

    const q = state.sessionQuestions[state.currentIdx];
    state.userAnswers.set(q.id, letter);
    state.answered = true;

    QuizEngine.clearTimer();

    // Re-render options with correct/wrong highlights
    const buttons = document.querySelectorAll('.option-btn');
    const correctLetter = q.answer.toLowerCase();

    buttons.forEach(btn => {
      btn.disabled = true;
      const l = btn.dataset.letter.toLowerCase();
      if (l === correctLetter) {
        btn.classList.add('correct');
      } else if (l === letter.toLowerCase() && l !== correctLetter) {
        btn.classList.add('wrong');
      }
    });

    const isMatch = letter.toLowerCase() === correctLetter;
    const correctText = q.options[q.answer] || q.options[correctLetter] || '';
    
    $('skipNote').innerHTML = isMatch 
      ? '<span style="color:var(--green)">✅ Correct!</span>' 
      : `<span style="color:var(--rose)">❌ Correct answer:</span> <strong>(${correctLetter.toUpperCase()}) ${escHtml(correctText)}</strong>`;
  }

  function nextQ() {
    const total = state.sessionQuestions.length;
    if (state.currentIdx < total - 1) {
      state.currentIdx++;
      state.answered = false;
      renderQuestion();
    } else {
      finishQuiz();
    }
  }

  function prevQ() {
    if (state.currentIdx > 0) {
      state.currentIdx--;
      state.answered = !!state.userAnswers.get(state.sessionQuestions[state.currentIdx].id);
      renderQuestion();
    }
  }

  function quitQuiz() {
    if (!confirm('Quit this quiz? Your progress will be lost.')) return;
    QuizEngine.clearTimer();
    showView('upload');
  }

  /* ═══════════════════════════════════════════════════════════
     RESULTS VIEW
     ═══════════════════════════════════════════════════════════ */

  function finishQuiz() {
    QuizEngine.clearTimer();

    const score = QuizEngine.calculateScore(state.sessionQuestions, state.userAnswers);
    const feedback = QuizEngine.getFeedback(score.percentage);

    // Save history
    const sourceNames = [...new Set(state.sessionQuestions.map(q => q.source))];
    Storage.saveHistory({
      date:       new Date().toISOString(),
      score:      score.correct,
      total:      score.total,
      percentage: score.percentage,
      sources:    sourceNames,
    });

    showView('results');
    renderResults(score, feedback);
  }

  function renderResults(score, feedback) {
    // Score ring
    const offset = QuizEngine.getScoreArcOffset(score.percentage);
    const arc    = $('scoreArc');

    // Set color based on score (Bright Theme)
    let color = 'var(--rose)';
    if (score.percentage >= 80) color = 'var(--green)';
    else if (score.percentage >= 60) color = 'var(--amber)';
    else if (score.percentage >= 40) color = 'var(--accent)';
    arc.style.stroke = color;

    // Animate the ring
    setTimeout(() => { arc.style.strokeDashoffset = offset; }, 100);

    $('scorePct').textContent   = `${score.percentage}%`;
    $('scoreStats').innerHTML   = `<strong>${score.correct}</strong> correct · <strong>${score.wrong}</strong> wrong · <strong>${score.skipped}</strong> skipped out of <strong>${score.total}</strong>`;
    $('scoreFeedback').textContent = `${feedback.emoji} ${feedback.text}`;

    // Confetti for high scores
    if (score.percentage >= 80) launchConfetti();

    // Review list
    const reviewList = $('reviewList');
    reviewList.innerHTML = state.sessionQuestions.map((q, idx) => {
      const ua = state.userAnswers.get(q.id);
      let status, cls;
      if (!ua) {
        status = '⏩'; cls = 'review-skip';
      } else if (ua === q.answer) {
        status = '✅'; cls = 'review-correct';
      } else {
        status = '❌'; cls = 'review-wrong';
      }

      const userOptText    = ua ? `(${ua.toUpperCase()}) ${escHtml(q.options[ua] || '')}` : 'Skipped';
      const correctOptText = `(${q.answer.toUpperCase()}) ${escHtml(q.options[q.answer] || '')}`;

      return `
        <div class="review-item ${cls}">
          <div class="review-q-header">
            <span class="review-q-num">Q${idx + 1} · ${escHtml(q.source)}</span>
            <span class="review-status-icon">${status}</span>
          </div>
          <div class="review-q-text">${escHtml(q.question)}</div>
          ${ua && ua !== q.answer ? `
          <div class="review-answers">
            <span class="review-your-answer">Your answer: ${userOptText}</span>
            <span class="review-correct-answer">Correct: ${correctOptText}</span>
          </div>` : ''}
          ${ua === q.answer ? `
          <div class="review-answers">
            <span class="review-correct-answer">✔ ${correctOptText}</span>
          </div>` : ''}
          ${!ua ? `
          <div class="review-answers">
            <span class="review-correct-answer">Answer: ${correctOptText}</span>
          </div>` : ''}
        </div>
      `;
    }).join('');
  }

  function retryQuiz() {
    // Rebuild session with same questions (re-shuffled)
    const allQ = state.sessionQuestions;
    const count = allQ.length;
    try {
      const session = QuizEngine.buildSession(allQ, count);
      startQuiz(session);
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  /* ═══════════════════════════════════════════════════════════
     HISTORY
     ═══════════════════════════════════════════════════════════ */
  function showHistory() {
    const history = Storage.getHistory();
    if (!history.length) { toast('No quiz history yet!', 'info'); return; }
    // For now just show a toast summary
    const last = history[0];
    toast(`Last quiz: ${last.percentage}% (${last.score}/${last.total}) on ${new Date(last.date).toLocaleDateString()}`, 'info', 4000);
  }

  /* ═══════════════════════════════════════════════════════════
     CONFETTI
     ═══════════════════════════════════════════════════════════ */
  function launchConfetti() {
    const canvas = $('confettiCanvas');
    canvas.style.display = '';
    const ctx    = canvas.getContext('2d');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;

    const particles = Array.from({ length: 120 }, () => ({
      x:   Math.random() * canvas.width,
      y:   -10 - Math.random() * 100,
      r:   Math.random() * 6 + 3,
      c:   `hsl(${Math.random() * 360}, 80%, 60%)`,
      vx:  (Math.random() - 0.5) * 4,
      vy:  Math.random() * 3 + 2,
      rot: Math.random() * 360,
      rv:  (Math.random() - 0.5) * 6,
    }));

    let frame = 0;
    function tick() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rot * Math.PI) / 180);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
        ctx.restore();
        p.x   += p.vx;
        p.y   += p.vy;
        p.rot += p.rv;
        p.vy  += 0.05; // gravity
      });
      frame++;
      if (frame < 160) requestAnimationFrame(tick);
      else { ctx.clearRect(0, 0, canvas.width, canvas.height); canvas.style.display = 'none'; }
    }
    requestAnimationFrame(tick);
  }

  /* ═══════════════════════════════════════════════════════════
     UTILITIES
     ═══════════════════════════════════════════════════════════ */
  function escHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  /* ── Navigation shortcuts ───────────────────────────────── */
  function goHome() { showView('upload'); renderLibrary(); }

  /* ═══════════════════════════════════════════════════════════
     INIT
     ═══════════════════════════════════════════════════════════ */
  function init() {
    // Load banks from storage
    state.banks = Storage.getBanks();

    // Setup upload zone
    initUploadZone();

    // Render library if any existing banks
    renderLibrary();

    // Keyboard shortcut for quiz nav
    document.addEventListener('keydown', (e) => {
      const view = document.querySelector('.view.active');
      if (!view || view.id !== 'view-quiz') return;
      if (e.key === 'ArrowRight' || e.key === 'Enter') nextQ();
      if (e.key === 'ArrowLeft')  prevQ();
      // Number keys 1-4 select options
      if (['1','2','3','4'].includes(e.key)) {
        const letters = ['a','b','c','d'];
        const letter  = letters[parseInt(e.key) - 1];
        if (letter) selectOption(letter);
      }
    });
  }

  // Run on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Public API
  return {
    goHome, showConfig, showHistory,
    loadFromUrl, removeBank, clearLibrary,
    selectAllPdfs, setCount, setTimerSecs, toggleTimer,
    beginQuiz,
    nextQ, prevQ, quitQuiz,
    retryQuiz,
  };

})();
