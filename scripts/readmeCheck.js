// Asks Haiku the newcomer questions in docs/design/readme-check.md, giving it
// README.md and nothing else, and fails if any answer is missing from the page
// or given with low confidence. Run by hand (it needs a logged-in Claude Code
// CLI and costs tokens), not in CI.
//
//   node scripts/readmeCheck.js                 check README.md, print a table
//   node scripts/readmeCheck.js --out <file>    also save the answers as JSON
//   node scripts/readmeCheck.js --readme <path> check another Markdown file
//
// Haiku runs through `claude -p` with no tools, no MCP servers, no settings or
// slash commands, a replaced system prompt, and an empty temporary folder as
// its working directory, so the README text in the prompt is all it sees.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const QUESTIONS_DOC = path.join(root, 'docs', 'design', 'readme-check.md');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// The questions are the numbered list under "## Questions" in the doc, so the
// doc and the check can't drift apart.
function readQuestions() {
  const text = fs.readFileSync(QUESTIONS_DOC, 'utf8');
  const section = text.split(/^## Questions\s*$/m)[1];
  if (!section) throw new Error(`no "## Questions" section in ${path.relative(root, QUESTIONS_DOC)}`);
  const questions = [];
  for (const line of section.split(/^## /m)[0].split('\n')) {
    const m = /^(\d+)\.\s+(.*\S)\s*$/.exec(line);
    if (m) questions.push({ id: Number(m[1]), text: m[2] });
  }
  if (questions.length === 0) throw new Error('no numbered questions found');
  return questions;
}

const SYSTEM = [
  'You are a developer who has never heard of this project. You are reading its README for the first time.',
  'You know only what the README text in the user message says. Do not use anything you may know about the project from elsewhere, and do not guess at features the page does not describe.',
  'Answer each question in two to four plain sentences, from the page only.',
  'If the page does not answer the question, or any part of it, put the literal marker NOT IN PAGE in the answer and say which part is missing.',
  'Rate your confidence in each answer: "high" if the page states it directly, "medium" if you had to piece it together or infer a little, "low" if you are mostly guessing.',
  'For opinion questions (such as whether a new user would know what to do), answer from what the page gives a reader, and use NOT IN PAGE if the page leaves the reader without the needed guidance.',
].join(' ');

const SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          answer: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['id', 'answer', 'confidence'],
      },
    },
  },
  required: ['answers'],
};

function askHaiku(readme, questions) {
  const prompt = [
    'Here is the README, between the markers.',
    '<<<README',
    readme,
    'README>>>',
    '',
    'Answer every question below, by its number.',
    ...questions.map((q) => `${q.id}. ${q.text}`),
  ].join('\n');

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'snagboat-readme-check-'));
  try {
    const result = spawnSync(
      'claude',
      [
        '-p',
        '--model', 'haiku',
        '--tools', '',
        '--strict-mcp-config',
        '--setting-sources', '',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--system-prompt', SYSTEM,
        '--output-format', 'json',
        '--json-schema', JSON.stringify(SCHEMA),
      ],
      { cwd, input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`claude exited ${result.status}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
    }
    const envelope = JSON.parse(result.stdout);
    if (envelope.is_error) throw new Error(`claude reported an error: ${String(envelope.result).slice(0, 500)}`);
    const output = envelope.structured_output ?? JSON.parse(envelope.result);
    return { answers: output.answers, model: Object.keys(envelope.modelUsage ?? {})[0], costUsd: envelope.total_cost_usd };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function main() {
  const readmePath = path.resolve(arg('--readme') ?? path.join(root, 'README.md'));
  const outPath = arg('--out');
  const questions = readQuestions();
  const readme = fs.readFileSync(readmePath, 'utf8');

  console.log(`Asking Haiku ${questions.length} questions about ${path.relative(root, readmePath)}...`);
  const { answers, model, costUsd } = askHaiku(readme, questions);
  const byId = new Map(answers.map((a) => [a.id, a]));

  const rows = questions.map((q) => {
    const a = byId.get(q.id);
    if (!a) return { id: q.id, question: q.text, confidence: '-', notInPage: true, pass: false, answer: '(no answer)' };
    const notInPage = a.answer.includes('NOT IN PAGE');
    return { id: q.id, question: q.text, confidence: a.confidence, notInPage, pass: !notInPage && a.confidence !== 'low', answer: a.answer };
  });

  console.log('\n  #  confidence  in page  result');
  for (const r of rows) {
    console.log(`${String(r.id).padStart(3)}  ${r.confidence.padEnd(10)}  ${(r.notInPage ? 'no' : 'yes').padEnd(7)}  ${r.pass ? 'pass' : 'FAIL'}`);
  }
  const failed = rows.filter((r) => !r.pass);
  console.log(`\n${rows.length - failed.length}/${rows.length} passed (${model ?? 'unknown model'})`);
  for (const r of failed) console.log(`\n${r.id}. ${r.question}\n   ${r.answer}`);

  if (outPath) {
    const record = {
      date: new Date().toISOString().slice(0, 10),
      readme: path.relative(root, readmePath),
      model,
      costUsd,
      passed: rows.length - failed.length,
      total: rows.length,
      results: rows,
    };
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + '\n');
    console.log(`\nSaved ${outPath}`);
  }
  if (failed.length > 0) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(`readmeCheck: ${err.message}`);
  process.exit(2);
}
