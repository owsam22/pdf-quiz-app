/* pdf-parser.js
   Robust MCQ extractor for NPTEL-style assignment PDFs.
   Handles: MCQ, True/False, Fill-in-the-blank question types.
   Accurately parses the answer key table at the end of each doc.
   ================================================================ */

const PDFParser = (() => {

  /* ── PDF.js setup ──────────────────────────────────────────── */
  // Set the worker source (from same CDN version as pdf.min.js)
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }

  /* ═══════════════════════════════════════════════════════════
     STEP 1 — Load & extract text lines from PDF, grouped by Y
     ═══════════════════════════════════════════════════════════ */
  async function extractLinesFromFile(source, onProgress) {
    let pdfDoc;
    if (source instanceof File) {
      const buf = await source.arrayBuffer();
      pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
    } else if (typeof source === 'string') {
      // URL (could be a proxy-converted Drive link)
      pdfDoc = await pdfjsLib.getDocument({ url: source, withCredentials: false }).promise;
    } else if (source instanceof ArrayBuffer) {
      pdfDoc = await pdfjsLib.getDocument({ data: source }).promise;
    } else {
      throw new Error('Unsupported source type');
    }

    const totalPages = pdfDoc.numPages;
    const allLines = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      if (onProgress) onProgress(pageNum, totalPages);

      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();

      // Group text items by Y position (rounded to 3-unit buckets for robustness)
      const YMap = new Map();
      for (const item of textContent.items) {
        const rawText = item.str;
        if (!rawText) continue;
        const y = Math.round(item.transform[5] / 3) * 3;
        const x = item.transform[4];
        if (!YMap.has(y)) YMap.set(y, []);
        YMap.get(y).push({ x, text: rawText });
      }

      // Sort by Y descending (PDF coords: higher Y = higher on page)
      const sortedYs = Array.from(YMap.keys()).sort((a, b) => b - a);

      for (const y of sortedYs) {
        const items = YMap.get(y).sort((a, b) => a.x - b.x);
        // Join items on same line — add space when gap between items > 2 units
        let lineText = '';
        let prevEndX = null;
        for (const it of items) {
          if (prevEndX !== null && it.x - prevEndX > 2) lineText += ' ';
          lineText += it.text;
          // Approximate end X (we don't have width, so use next item's start)
          prevEndX = it.x + (it.text.length * 6); // rough estimate
        }
        const cleaned = lineText.trim();
        if (cleaned) allLines.push(cleaned);
      }

      allLines.push(''); // blank line between pages as natural separator
    }

    return allLines;
  }

  /* ═══════════════════════════════════════════════════════════
     STEP 2 — Clean lines: remove headers, footers, page numbers
     ═══════════════════════════════════════════════════════════ */

  const NOISE_PATTERNS = [
    // Page number patterns like "1 | P a g e", "2 | Page", "Page 1"
    /^\d+\s*\|\s*P(\s*a\s*g\s*e|age)/i,
    /^P\s*a\s*g\s*e\s*\d+/i,
    /^Page\s+\d+\s*$/i,
    /^\d+\s*$/,                           // standalone numbers (page nums)
    // NPTEL / IIT boilerplate lines
    /^NPTEL\s+Online\s+Certification/i,
    /^Indian\s+Institute\s+of\s+Technology/i,
    /^Course\s+Name\s*:/i,
    /^Instructor\s*:/i,
    /^Prof\.?\s*/i,
    /^\*+\s*End\s+of/i,                   // "*** End of Page ***"
    /^\*+\s*[A-Z ]+\*+$/i,              // "********** END OF THE PAGE ************"
    /^\*+\s*$/,                           // lines of only asterisks
    /^-{3,}PAGE_BREAK-{3,}$/,            // our own separator
    /^_{3,}$/,                            // underline separators
    /^\|?\s*Page\s*$/i,                   // "| Page"
  ];

  function isNoiseLine(line) {
    const t = line.trim();
    if (!t) return true;
    for (const p of NOISE_PATTERNS) {
      if (p.test(t)) return true;
    }
    return false;
  }

  /* Fix spaced characters: "P a g e" → "Page", "T r u e" → "True" etc. */
  function fixSpacedChars(line) {
    // Match sequences of single-char tokens separated by spaces
    return line.replace(/\b([A-Za-z](\s[A-Za-z]){2,})\b/g, (match) => {
      return match.replace(/\s/g, '');
    });
  }

  function cleanLines(lines) {
    return lines
      .map(l => fixSpacedChars(l))
      .filter(l => !isNoiseLine(l));
  }

  /* ═══════════════════════════════════════════════════════════
     STEP 3 — Find and parse the Answer Key table
     ═══════════════════════════════════════════════════════════ */

  /**
   * Looks for the answer table by searching for "Question Number" or
   * similar heading. Returns { answerKey: Map<number,string>, tableStartIdx: number }
   */
  function parseAnswerKey(lines) {
    const answerKey = new Map(); // qNumber (int) → letter ('a'|'b'|'c'|'d'|'true'|'false')
    let tableStartIdx = -1;

    // Find the header row
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].toLowerCase();
      
      // Look for "Answer keys:" or "Answer key:" or "Answers:"
      if (/^answer\s*keys?\b/i.test(l) || /^answers\b/i.test(l)) {
        tableStartIdx = i;
        break;
      }

      if (
        (l.includes('question') || l.includes('q.')) &&
        (/question\s*number/i.test(l) || /question\s*no/i.test(l) || /question\s*correct/i.test(l)) &&
        (/correct/i.test(l) || /answer/i.test(l) || /option/i.test(l))
      ) {
        tableStartIdx = i;
        break;
      }
      // Also catch simpler variants: "Ans:" table, standalone table header, or directly the header from example 3
      if (
        /^(question\s*no\.?\s*correct|q\.?\s+ans\.?)/i.test(lines[i]) ||
        /question\s+correct\s+option\s+\/\s+answer/i.test(l)
      ) {
        tableStartIdx = i;
        break;
      }
    }

    if (tableStartIdx === -1) return { answerKey, tableStartIdx };

    // Parse rows below the header
    // Row formats encountered:
    //   "1 (a)"   "1 a"   "1. (a)"   "1 (True)"   "10 (b)"   "1. b)"
    const ROW_RE = /^(\d+)[\s.\-:]+([\(\[]?([a-dA-D]|True|False|true|false|TRUE|FALSE)[\)\]]?)/;

    for (let i = tableStartIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const m = ROW_RE.exec(line);
      if (m) {
        const qNum = parseInt(m[1], 10);
        const raw  = m[3].toLowerCase();
        // Normalize: 'true' → 'b' if it matches the True/False option mapping
        // We store as-is ('a','b','c','d','true','false') and resolve later
        answerKey.set(qNum, raw);
      } else if (line.toLowerCase() === 'end' || /^\*+/.test(line)) {
        // End of table
        break;
      }
    }

    return { answerKey, tableStartIdx };
  }

  /* ═══════════════════════════════════════════════════════════
     STEP 4 — Parse questions from the cleaned line array
     ═══════════════════════════════════════════════════════════ */

  /* Detects if a line is the start of a new question */
  // Patterns: "1.", "1 .", "1)", "1 ."
  const Q_START_RE   = /^(\d+)\s*[.)]\s*/;
  /* Detects option lines: "(a)", "a)", "a.", "A).", "A.)", "A )" */
  const OPT_RE       = /^\(?([a-dA-D])[\s.)\]]+\s*\S/;
  const OPT_LETTER_RE= /^\(?([a-dA-D])[\s.)\]]+\s*(.*)/;

  /**
   * Determine question type from question text content and options.
   */
  function detectType(qText, options = {}) {
    const lowerQ = qText.toLowerCase();
    
    // Check question text first
    if (lowerQ.includes('true/false') || lowerQ.includes('(true/false)') || lowerQ.includes('true or false'))
      return 'True / False';
    if (lowerQ.includes('fill in the blank') || lowerQ.includes('fill in the blanks') || lowerQ.includes('fill-in'))
      return 'Fill in the Blank';
    
    // Check options if available
    const optValues = Object.values(options).map(v => v.trim().toLowerCase());
    if (optValues.includes('true') && optValues.includes('false')) {
      return 'True / False';
    }

    return 'MCQ';
  }

  /**
   * Main parsing function.
   * Returns array of question objects.
   */
  function parseQuestions(lines, answerKey, answerTableStart, sourceName) {
    const questions = [];
    // Only look at lines before the answer table
    const workLines = answerTableStart >= 0 ? lines.slice(0, answerTableStart) : lines;

    let i = 0;
    while (i < workLines.length) {
      const line = workLines[i].trim();
      const qMatch = Q_START_RE.exec(line);
      if (!qMatch) { i++; continue; }

      const qNum = parseInt(qMatch[1], 10);
      // Collect question text
      let qTextParts = [line.replace(/^(\d+)\s*[.)]\s*/, '').trim()];
      i++;

      while (i < workLines.length) {
        const next = workLines[i].trim();
        if (!next) { i++; continue; }
        if (Q_START_RE.test(next)) break;       // next question starts
        if (OPT_RE.test(next)) break;           // first option found
        qTextParts.push(next);
        i++;
      }

      const qText = qTextParts.join(' ').trim();
      if (!qText) continue;

      // Collect options
      const options = {};  // { a: '...', b: '...', c: '...', d: '...' }
      let lastLetter = null;

      while (i < workLines.length) {
        const next = workLines[i].trim();
        if (!next) { i++; continue; }
        if (Q_START_RE.test(next)) break;       // next question starts

        const optMatch = OPT_LETTER_RE.exec(next);
        if (optMatch) {
          const letter = optMatch[1].toLowerCase();
          lastLetter = letter;
          options[letter] = optMatch[2].trim();
          i++;
        } else if (lastLetter) {
          // Continuation line of the previous option
          options[lastLetter] += ' ' + next;
          i++;
        } else {
          // Belongs to question text still? (edge case)
          break;
        }
      }

      // Must have at least 2 options to be valid
      if (Object.keys(options).length < 2) continue;

      const type   = detectType(qText, options);
      const answer = answerKey.get(qNum) || null;

      /* Resolve 'true'/'false' answers to option letters for True/False questions.
         Usually (a) = False, (b) = True — but we check the actual option text. */
      let resolvedAnswer = answer;
      if (answer === 'true' || answer === 'false') {
        // Find which letter has matching text
        for (const [letter, text] of Object.entries(options)) {
          if (text.trim().toLowerCase() === answer) {
            resolvedAnswer = letter;
            break;
          }
        }
      }

      questions.push({
        id:       `q_${sourceName}_${qNum}`,
        number:   qNum,
        type:     type,
        question: qText,
        options:  options,            // { a, b, c, d }
        answer:   resolvedAnswer,     // 'a'|'b'|'c'|'d' or null if not in key
        source:   sourceName,
      });
    }

    return questions;
  }

  /* ═══════════════════════════════════════════════════════════
     STEP 5 — Validate questions (flag missing answers)
     ═══════════════════════════════════════════════════════════ */
  function validateQuestions(questions) {
    let warned = 0;
    for (const q of questions) {
      if (!q.answer) {
        q.answerMissing = true;
        warned++;
      }
      // Verify the answer letter actually exists in options
      if (q.answer && !q.options[q.answer]) {
        console.warn(`Q${q.number}: answer '${q.answer}' not in options`, q.options);
        q.answerMissing = true;
        warned++;
      }
    }
    return warned;
  }

  /* ═══════════════════════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════════════════════ */

  /**
   * Main entry point.
   * @param {File|string|ArrayBuffer} source
   * @param {string} name  — display name for the source
   * @param {function} onProgress (pageNum, totalPages) => void
   * @returns {Promise<{ questions, warnings }>}
   */
  async function parse(source, name, onProgress) {
    // 1. Extract raw lines from PDF
    const rawLines = await extractLinesFromFile(source, onProgress);

    // 2. Clean lines
    const lines = cleanLines(rawLines);

    // 3. Parse answer key (must happen before question parsing)
    const { answerKey, tableStartIdx } = parseAnswerKey(lines);

    // 4. Parse questions
    const questions = parseQuestions(lines, answerKey, tableStartIdx, name);

    // 5. Validate
    const warnings = validateQuestions(questions);

    console.log(`[PDFParser] "${name}": ${questions.length} questions, ${answerKey.size} answers, ${warnings} warnings`);

    return { questions, warnings };
  }

  /**
   * Convert Google Drive share URL to a direct-download URL.
   * Input:  https://drive.google.com/file/d/FILE_ID/view
   * Output: https://drive.google.com/uc?export=download&id=FILE_ID
   */
  function convertDriveUrl(url) {
    // Pattern: /file/d/<ID>/
    const fileMatch = url.match(/\/file\/d\/([^\/]+)/);
    if (fileMatch) {
      return `https://drive.google.com/uc?export=download&id=${fileMatch[1]}`;
    }
    // Pattern: id=<ID>
    const idMatch = url.match(/[?&]id=([^&]+)/);
    if (idMatch) {
      return `https://drive.google.com/uc?export=download&id=${idMatch[1]}`;
    }
    // Already a direct URL or unknown — return as-is
    return url;
  }

  return { parse, convertDriveUrl };

})();
