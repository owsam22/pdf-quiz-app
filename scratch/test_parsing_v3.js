
const NOISE_PATTERNS = [
    /^\d+\s*\|\s*P(\s*a\s*g\s*e|age)/i,
    /^P\s*a\s*g\s*e\s*\d+/i,
    /^Page\s+\d+\s*$/i,
    /^\d+\s*$/,
    /^NPTEL\s+Online\s+Certification/i,
    /^Indian\s+Institute\s+of\s+Technology/i,
    /^Course\s+Name\s*:/i,
    /^Instructor\s*:/i,
    /^Prof\.?\s*/i,
    /^\*+\s*End\s+of/i,
    /^\*+\s*[A-Z ]+\*+$/i,
    /^\*+\s*$/,
    /^-{3,}PAGE_BREAK-{3,}$/,
    /^_{3,}$/,
    /^\|?\s*Page\s*$/i,
];

function isNoiseLine(line) {
    const t = line.trim();
    if (!t) return true;
    for (const p of NOISE_PATTERNS) {
        if (p.test(t)) return true;
    }
    return false;
}

function fixSpacedChars(line) {
    return line.replace(/\b([A-Za-z](\s[A-Za-z]){2,})\b/g, (match) => {
        return match.replace(/\s/g, '');
    });
}

function cleanLines(lines) {
    return lines
        .map(l => fixSpacedChars(l))
        .filter(l => !isNoiseLine(l));
}

function parseAnswerKey(lines) {
    const answerKey = new Map();
    let tableStartIdx = -1;

    console.log('--- parseAnswerKey Debug ---');
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i].toLowerCase();
        
        const isHeader = (
            (l.includes('question') || l.includes('q.')) &&
            (/question\s*number/i.test(l) || /question\s*no/i.test(l) || /question\s*correct/i.test(l)) &&
            (/correct/i.test(l) || /answer/i.test(l) || /option/i.test(l))
        ) || /^answer\s*keys?\b/i.test(l) || /^answers\b/i.test(l) ||
        /question\s+correct\s+option\s+\/\s+answer/i.test(l);
        
        if (isHeader) {
            console.log(`Found header at line ${i}: "${lines[i]}"`);
            tableStartIdx = i;
            break;
        }
    }

    if (tableStartIdx === -1) {
        console.log('No header found!');
        return { answerKey, tableStartIdx };
    }

    const ROW_RE = /^(\d+)[\s.\-:]+([\(\[]?([a-dA-D]|True|False|true|false|TRUE|FALSE)[\)\]]?)/;

    for (let i = tableStartIdx + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        const m = ROW_RE.exec(line);
        if (m) {
            const qNum = parseInt(m[1], 10);
            const raw  = m[3].toLowerCase();
            console.log(`Matched row: "${line}" -> Q${qNum}: ${raw}`);
            answerKey.set(qNum, raw);
        } else {
            console.log(`No match for line: "${line}"`);
            if (line.toLowerCase() === 'end' || /^\*+/.test(line)) {
                console.log('End of table marker found.');
                break;
            }
        }
    }

    return { answerKey, tableStartIdx };
}

const Q_START_RE   = /^(\d+)[.)]\s+\S/;
const OPT_RE       = /^\([a-dA-D]\)\s*\S|^[a-dA-D][.)]+\s+\S/;
const OPT_LETTER_RE= /^\(?([a-dA-D])[.)]+\s*(.*)/;

function detectType(qText, options = {}) {
    const lowerQ = qText.toLowerCase();
    if (lowerQ.includes('true/false') || lowerQ.includes('(true/false)') || lowerQ.includes('true or false'))
      return 'True / False';
    if (lowerQ.includes('fill in the blank') || lowerQ.includes('fill in the blanks') || lowerQ.includes('fill-in'))
      return 'Fill in the Blank';
    
    const optValues = Object.values(options).map(v => v.trim().toLowerCase());
    if (optValues.includes('true') && optValues.includes('false')) {
      return 'True / False';
    }
    return 'MCQ';
}

function parseQuestions(lines, answerKey, answerTableStart, sourceName) {
    const questions = [];
    const workLines = answerTableStart >= 0 ? lines.slice(0, answerTableStart) : lines;

    let i = 0;
    while (i < workLines.length) {
      const line = workLines[i].trim();
      const qMatch = Q_START_RE.exec(line);
      if (!qMatch) { i++; continue; }

      const qNum = parseInt(qMatch[1], 10);
      let qTextParts = [line.replace(/^\d+[.)]\s+/, '').trim()];
      i++;

      while (i < workLines.length) {
        const next = workLines[i].trim();
        if (!next) { i++; continue; }
        if (Q_START_RE.test(next)) break;
        if (OPT_RE.test(next)) break;
        qTextParts.push(next);
        i++;
      }

      const qText = qTextParts.join(' ').trim();
      if (!qText) continue;

      const options = {};
      let lastLetter = null;

      while (i < workLines.length) {
        const next = workLines[i].trim();
        if (!next) { i++; continue; }
        if (Q_START_RE.test(next)) break;

        const optMatch = OPT_LETTER_RE.exec(next);
        if (optMatch) {
          const letter = optMatch[1].toLowerCase();
          lastLetter = letter;
          options[letter] = optMatch[2].trim();
          i++;
        } else if (lastLetter) {
          options[lastLetter] += ' ' + next;
          i++;
        } else {
          break;
        }
      }

      const hasAnswer = answerKey.has(qNum);
      if (Object.keys(options).length < 2) {
          // console.log(`Skipping Q${qNum} because < 2 options`);
          continue;
      }

      const type   = detectType(qText, options);
      const answer = answerKey.get(qNum) || null;

      let resolvedAnswer = answer;
      if (answer === 'true' || answer === 'false') {
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
        options:  options,
        answer:   resolvedAnswer,
        source:   sourceName,
      });
    }

    return questions;
}

const example3 = `1. At which MCOD stage does an organization actively welcome diverse candidate?
a) The Club
b) The Compliance Organization
c) The Affirming Organization
d) The Exclusionary Organization
2. Role clarification in teams increases:
a) Role ambiguity
b) Efficiency and mutual understanding
c) Competition among members
d) Disconnection in communication
3. Which law emphasizes the importance of a shared goal over personal roles?
a) Law of the Bad Apple
b) Law of the Big Picture
c) Law of Communication
d) Law of Chain
4. The Kolb cycle includes which stage?
a) Abstract conceptualization
b) Programmed repetition
c) Isolated experimentation
d) Passive watching
5. Kolb's "Converging" learning style is associated with:
a) Watching only
b) technical problem solving and active experimentation
c) Avoidance of new experiences
d) Ignoring group feedback
6. A key role in action learning teams is the:
a) Passive observer
b) Action learning coach guiding reflection and feedback
c) Group analyst
d) Isolated implementer
7. The action learning cycle is inspired by:
a) Plan-Do-Check-Act
b) Memorization cycle
c) Fixed feedback process
d) Non-collaborative routines
8. The GAPS model stands for:
a) Guidance, Action, Performance, Strengths
b) Goals, Abilities, Perceptions, Standards
c) Growth, Autonomy, Planning, Success
NPTEL Online Certification Course
Indian Institute of Technology Roorkee
Course Name: Leadership and Team Effectiveness
Instructor: Prof.Santosh Rangnekar

2 | P a g e

d) General Aspirations, Professional Strategy
9. (True/False) Multicultural organizations integrate diversity at every level.
a) True
b) False
10. (Fill in the Blank) The affirmative stage in MCOD represents a commitment to
__________ discriminatory practices.
a) Promoting
b) Ignoring
c) Eliminating
d) Standardizing

Question    Correct    Option / Answer
1 c
2 b
3 b
4 a
5 b
6 b
7 a
8 b
9 a
10 c`;

const lines = example3.split('\n');
const cleaned = cleanLines(lines);
const { answerKey, tableStartIdx } = parseAnswerKey(cleaned);
const questions = parseQuestions(cleaned, answerKey, tableStartIdx, "Example 3");
console.log(`\nFinal result: ${questions.length} questions.`);
if (questions.length === 10) {
    console.log('SUCCESS: All 10 questions found.');
} else {
    console.log('FAILURE: Only ' + questions.length + ' questions found.');
}
