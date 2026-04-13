

// ── Constants ──────────────────────────────────────────────────
const VALID_OPCODES = new Set([
  'READ', 'WRIT', 'LOAD', 'STOR',
  'ADD',  'SUB',  'DIV',  'MULT',
  'JUMP', 'JMPN', 'JMPZ', 'MODA',
  'HALT'
]);
const MEM_SIZE = 100;
const MAX_STEPS = 100000;

// ── Machine state 
let memory     = new Array(MEM_SIZE).fill(0); 
let prevMemory = new Array(MEM_SIZE).fill(0);
let PC   = 0;
let IR   = null;
let OR   = 0;
let ACC  = 0;
let prevACC = 0;

let assembled       = false;
let halted          = false;
let running         = false;
let waitingForInput = false;
let inputAddr       = -1;
let inputResolve    = null;
let stepCount       = 0;
let programLines    = []; // source line index per instruction address

// ── DOM refs ───────────────────────────────────────────────────
const editor      = document.getElementById('code-editor');
const lineNumbers = document.getElementById('line-numbers');
const outputLog   = document.getElementById('output-log');

// ═══════════════════════════════════════════════════════════════
//  EDITOR — line numbers & sync scroll
// ═══════════════════════════════════════════════════════════════
function updateLineNumbers() {
  const lines = editor.value.split('\n');
  document.getElementById('line-count-tag').textContent = lines.length + ' LINES';
  let html = '';
  lines.forEach((_, i) => {
    const isCurrent = assembled && !halted && (i === programLines[PC]);
    html += `<div class="ln${isCurrent ? ' current' : ''}">${i}</div>`;
  });
  lineNumbers.innerHTML = html;
  lineNumbers.scrollTop = editor.scrollTop;
}

editor.addEventListener('input',  updateLineNumbers);
editor.addEventListener('scroll', () => { lineNumbers.scrollTop = editor.scrollTop; });
editor.addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = editor.selectionStart;
    editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(editor.selectionEnd);
    editor.selectionStart = editor.selectionEnd = s + 2;
    updateLineNumbers();
  }
});

// ── File loader ────────────────────────────────────────────────
document.getElementById('file-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    editor.value = ev.target.result;
    updateLineNumbers();
    resetSim(false);
    logInfo(`📂 Loaded: ${file.name}`);
  };
  reader.onerror = () => logError(`Could not read file: ${file.name}`);
  reader.readAsText(file);
  e.target.value = '';
});

// ═══════════════════════════════════════════════════════════════
//  ASSEMBLER — parse & validate
// ═══════════════════════════════════════════════════════════════

/**
 * Parse the editor text into instruction and data lines.
 * Returns { instrLines, dataLines, errors }
 */
function parseProgram(text) {
  const lines      = text.split('\n');
  const errors     = [];
  const instrLines = [];   // { lineIdx, opcode, operand }
  const dataLines  = [];   // { lineIdx, addr, val }
  let   instrCount = 0;

  lines.forEach((raw, lineIdx) => {
    const humanLine = lineIdx + 1;                      // 1-based for messages
    const stripped  = raw.replace(/\/\/.*$/, '').trim(); // strip comments
    if (!stripped) return;                               // blank / comment-only

    const tokens = stripped.split(/\s+/);

    // ── Data line: first token is a pure integer ──────────────
    if (/^-?\d+$/.test(tokens[0]) && tokens.length >= 2) {
      const addr = parseInt(tokens[0]);
      const val  = parseInt(tokens[1]);

      if (isNaN(addr) || addr < 0 || addr >= MEM_SIZE) {
        errors.push(`Line ${humanLine}: Data address '${tokens[0]}' is out of range [0–${MEM_SIZE - 1}].`);
        return;
      }
      if (isNaN(val)) {
        errors.push(`Line ${humanLine}: Data value '${tokens[1]}' is not a valid integer.`);
        return;
      }
      dataLines.push({ lineIdx, addr, val });
      return;
    }

    // ── Instruction line ──────────────────────────────────────
    const opcode = tokens[0].toUpperCase();

    // Unknown opcode check
    if (!VALID_OPCODES.has(opcode)) {
      // Helpful hint if it looks like a typo
      const suggestion = closestOpcode(opcode);
      const hint = suggestion ? ` Did you mean '${suggestion}'?` : '';
      errors.push(`Line ${humanLine}: Unknown instruction '${tokens[0]}'.${hint}`);
      return;
    }

    // Missing operand (HALT is the only one that takes a placeholder, always 0)
    if (tokens.length < 2) {
      errors.push(`Line ${humanLine}: Instruction '${opcode}' is missing its operand.`);
      return;
    }

    // Non-integer operand
    if (!/^-?\d+$/.test(tokens[1])) {
      errors.push(`Line ${humanLine}: Operand '${tokens[1]}' for '${opcode}' must be an integer.`);
      return;
    }

    const operand = parseInt(tokens[1]);

    // HALT — operand must be 0
    if (opcode === 'HALT' && operand !== 0) {
      errors.push(`Line ${humanLine}: HALT operand must be 0 (got ${operand}).`);
      return;
    }

    // Operand range check (memory addresses)
    if (opcode !== 'HALT') {
      if (operand < 0 || operand >= MEM_SIZE) {
        errors.push(`Line ${humanLine}: Operand ${operand} for '${opcode}' is out of range [0–${MEM_SIZE - 1}].`);
        return;
      }
    }

    // Program too large
    instrCount++;
    if (instrCount > MEM_SIZE) {
      errors.push(`Line ${humanLine}: Program exceeds maximum size of ${MEM_SIZE} instructions.`);
      return;
    }

    instrLines.push({ lineIdx, opcode, operand });
  });

  // Cross-check: data lines don't overwrite instruction addresses
  const instrAddresses = new Set(instrLines.map((_, i) => i));
  dataLines.forEach(d => {
    if (instrAddresses.has(d.addr)) {
      errors.push(`Line ${d.lineIdx + 1}: Data at address ${d.addr} overlaps with an instruction.`);
    }
  });

  // Warn (not error) if no HALT found
  const hasHalt = instrLines.some(l => l.opcode === 'HALT');
  if (!hasHalt && instrLines.length > 0) {
    errors.push('Warning: No HALT instruction found — program may run off the end of memory.');
  }

  return { instrLines, dataLines, errors };
}

/**
 * Levenshtein-based "did you mean" for opcodes.
 */
function closestOpcode(input) {
  let best = null, bestDist = Infinity;
  VALID_OPCODES.forEach(op => {
    const d = levenshtein(input.toUpperCase(), op);
    if (d < bestDist && d <= 2) { bestDist = d; best = op; }
  });
  return best;
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[a.length][b.length];
}

// ── Assemble button handler ────────────────────────────────────
function assemble() {
  const text = editor.value.trim();

  if (!text) {
    logError('Editor is empty. Write a program first.');
    return;
  }

  const { instrLines, dataLines, errors } = parseProgram(text);

  if (errors.length) {
    clearLog();
    logError(`Assembly failed with ${errors.length} error(s):`);
    errors.forEach(e => logError('  ' + e));
    setStatus('ERROR', 'error');
    return;
  }

  // Clear and reload machine state
  memory     = new Array(MEM_SIZE).fill(0);
  prevMemory = new Array(MEM_SIZE).fill(0);
  PC = 0; IR = null; OR = 0; ACC = 0; prevACC = 0;
  halted    = false;
  assembled = true;
  stepCount = 0;
  clearLog();

  // Load instructions starting at address 0
  instrLines.forEach((instr, i) => {
    memory[i] = { opcode: instr.opcode, operand: instr.operand, lineIdx: instr.lineIdx };
  });
  programLines = instrLines.map(l => l.lineIdx);

  // Load data words
  dataLines.forEach(d => { memory[d.addr] = d.val; });
  prevMemory = memory.map(x => x);

  renderMemory();
  updateRegisters();
  updateLineNumbers();

  setBtn('btn-step',  false);
  setBtn('btn-run',   false);
  setBtn('btn-pause', true);
  setStatus('ASSEMBLED', 'active');
  document.getElementById('io-tag').textContent = 'READY';

  logInfo(`✓ Assembled: ${instrLines.length} instruction(s), ${dataLines.length} data word(s).`);
  logInfo('Press STEP to execute one instruction, or RUN to run the full program.');
}

// ══════════════════════════════════════════════════════════
async function step() {
  if (!assembled || halted || waitingForInput) return;

  // Infinite-loop guard
  stepCount++;
  if (stepCount > MAX_STEPS) {
    runtimeError(`Exceeded ${MAX_STEPS} steps — possible infinite loop. Use RESET to restart.`);
    return;
  }

  // PC bounds check
  if (PC < 0 || PC >= MEM_SIZE) {
    runtimeError(`Program Counter out of bounds: PC = ${PC}. Execution cannot continue.`);
    return;
  }

  const word = memory[PC];

  // No instruction at this address
  if (word === 0 || typeof word === 'number') {
    runtimeError(
      `No instruction at address ${PC} (value: ${word}).\n` +
      `The program may have jumped to a data region or run past the last instruction.`
    );
    return;
  }

  if (typeof word !== 'object' || !word.opcode) {
    runtimeError(`Corrupt memory at address ${PC}. Cannot decode instruction.`);
    return;
  }

  // Fetch
  IR = word.opcode;
  OR = word.operand;
  PC++;

  updateRegisters(true);

  // Execute
  await executeInstruction(IR, OR);

  updateRegisters();
  updateLineNumbers();
  renderMemory();
}

async function executeInstruction(op, addr) {
  prevACC    = ACC;
  prevMemory = memory.map(x => x);

  switch (op) {

    case 'READ':
      await doRead(addr);
      break;

    case 'WRIT': {
      const v = memVal(addr);
      logOutput(`OUTPUT ← MEM[${addr}] = ${v}`);
      break;
    }

    case 'LOAD':
      ACC = memVal(addr);
      break;

    case 'STOR':
      memory[addr] = ACC;
      break;

    case 'ADD':
      ACC += memVal(addr);
      break;

    case 'SUB':
      ACC -= memVal(addr);
      break;

    case 'DIV': {
      const divisor = memVal(addr);
      if (divisor === 0) {
        runtimeError(`Division by zero at address ${PC - 1} (MEM[${addr}] = 0).`);
        return;
      }
      ACC = Math.trunc(ACC / divisor);  // integer division
      break;
    }

    case 'MULT':
      ACC *= memVal(addr);
      break;

    case 'JUMP':
      if (addr < 0 || addr >= MEM_SIZE) {
        runtimeError(`JUMP target ${addr} is out of memory range [0–${MEM_SIZE - 1}].`);
        return;
      }
      PC = addr;
      break;

    case 'JMPN':
      if (addr < 0 || addr >= MEM_SIZE) {
        runtimeError(`JMPN target ${addr} is out of memory range [0–${MEM_SIZE - 1}].`);
        return;
      }
      if (ACC < 0) PC = addr;
      break;

    case 'JMPZ':
      if (addr < 0 || addr >= MEM_SIZE) {
        runtimeError(`JMPZ target ${addr} is out of memory range [0–${MEM_SIZE - 1}].`);
        return;
      }
      if (ACC === 0) PC = addr;
      break;

    case 'MODA': {
      const target = memory[addr];
      if (typeof target !== 'object' || !target.opcode) {
        runtimeError(
          `MODA: Address ${addr} does not contain an instruction (value: ${target}).\n` +
          `MODA can only modify the operand of an existing instruction.`
        );
        return;
      }
      const newOp = ACC;
      if (newOp < 0 || newOp >= MEM_SIZE) {
        runtimeError(`MODA: New operand value ${newOp} (from ACC) is out of range [0–${MEM_SIZE - 1}].`);
        return;
      }
      memory[addr] = { ...target, operand: newOp };
      break;
    }

    case 'HALT':
      doHalt();
      break;

    default:
      runtimeError(`Unknown opcode '${op}' encountered during execution.`);
  }
}

// ── HALT ───────────────────────────────────────────────────────
function doHalt() {
  halted = true;
  stopRun();
  setBtn('btn-step', true);
  setBtn('btn-run',  true);
  setStatus('HALTED', 'error');
  document.getElementById('io-tag').textContent = 'HALTED';
  logHalt(`■ HALT — Program completed normally after ${stepCount} step(s).`);
}

// ── READ (async, waits for user input) ────────────────────────
function doRead(addr) {
  return new Promise(resolve => {
    waitingForInput = true;
    inputAddr       = addr;
    inputResolve    = resolve;

    const field = document.getElementById('input-field');
    const sub   = document.getElementById('input-submit');
    field.disabled      = false;
    field.style.display = '';
    sub.style.display   = '';
    document.getElementById('io-tag').textContent = 'WAITING INPUT';
    logPrompt(`READ → MEM[${addr}] — Enter an integer and press Enter:`);
    field.focus();
  });
}

function submitInput() {
  if (!waitingForInput) return;
  const field = document.getElementById('input-field');
  const raw   = field.value.trim();

  if (raw === '') {
    logWarn('No value entered. Please type an integer.');
    field.focus();
    return;
  }

  if (!/^-?\d+$/.test(raw)) {
    logWarn(`'${raw}' is not a valid integer. Only whole numbers are accepted.`);
    field.value = '';
    field.focus();
    return;
  }

  const val = parseInt(raw, 10);
  memory[inputAddr] = val;
  logOutput(`  ↳ MEM[${inputAddr}] ← ${val}`);

  field.value        = '';
  field.disabled     = true;
  document.getElementById('input-submit').style.display = 'none';
  document.getElementById('io-tag').textContent = 'READY';
  waitingForInput = false;
  renderMemory();

  if (inputResolve) { inputResolve(); inputResolve = null; }
}

document.getElementById('input-field').addEventListener('keydown', e => {
  if (e.key === 'Enter') submitInput();
});

// ── Helper: safe memory read ───────────────────────────────────
function memVal(addr) {
  const v = memory[addr];
  if (typeof v === 'object' && v !== null) return v.operand; // instruction — return its operand as int
  return typeof v === 'number' ? v : 0;
}

// ═══════════════════════════════════════════════════════════════
//  RUN / PAUSE / RESET
// ═══════════════════════════════════════════════════════════════
async function runAll() {
  if (!assembled || halted || running) return;
  running = true;
  setBtn('btn-run',  true);
  setBtn('btn-step', true);
  setStatus('RUNNING', 'active');
  await runLoop();
}

async function runLoop() {
  while (running && !halted && assembled) {
    if (waitingForInput) {
      await sleep(50);
      continue;
    }
    await step();
    await sleep(100); // fixed pace — visible but not sluggish
    await sleep(0);   // yield to browser
  }
  if (!halted && !running) {
    setBtn('btn-run',  false);
    setBtn('btn-step', false);
  }
}

function stopRun() {
  running = false;
}

function resetSim(keepEditor = true) {
  stopRun();

  memory     = new Array(MEM_SIZE).fill(0);
  prevMemory = new Array(MEM_SIZE).fill(0);
  PC = 0; IR = null; OR = 0; ACC = 0; prevACC = 0;
  halted          = false;
  assembled       = false;
  waitingForInput = false;
  stepCount       = 0;
  programLines    = [];

  if (inputResolve) { inputResolve(); inputResolve = null; }

  const field = document.getElementById('input-field');
  field.disabled      = true;
  field.value         = '';
  document.getElementById('input-submit').style.display = 'none';
  document.getElementById('io-tag').textContent = 'READY';

  setBtn('btn-step', true);
  setBtn('btn-run',  true);
  setStatus('IDLE', '');

  renderMemory();
  updateRegisters();
  updateLineNumbers();
  clearLog();
  logInfo('Simulator reset. Write or load a program, then click ASSEMBLE.');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════
//  REGISTER DISPLAY
// ═══════════════════════════════════════════════════════════════
function updateRegisters(flash = false) {
  setReg('reg-pc', PC,                               flash);
  setReg('reg-ir', IR !== null ? IR  : '—',          flash);
  setReg('reg-or', IR !== null ? OR  : '—',          flash);

  const accEl = document.getElementById('reg-acc');
  accEl.textContent = ACC;
  if (ACC !== prevACC) {
    accEl.classList.add('changed');
    setTimeout(() => accEl.classList.remove('changed'), 400);
  }

  const flag = document.getElementById('acc-flag');
  flag.textContent = ACC < 0 ? 'NEGATIVE' : ACC === 0 ? 'ZERO' : 'POSITIVE';
}

function setReg(id, val, flash) {
  const el = document.getElementById(id);
  if (el && el.textContent !== String(val)) {
    el.textContent = val;
    if (flash) {
      el.classList.add('changed');
      setTimeout(() => el.classList.remove('changed'), 400);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  MEMORY DISPLAY
// ═══════════════════════════════════════════════════════════════
function renderMemory() {
  const grid = document.getElementById('memory-grid');
  let html = '';

  for (let i = 0; i < MEM_SIZE; i++) {
    const isPC  = assembled && !halted && i === PC;
    const word  = memory[i];
    let display, decVal;

    if (typeof word === 'object' && word !== null && word.opcode) {
      display = `${word.opcode} ${word.operand}`;
      decVal  = '';
    } else {
      const n = typeof word === 'number' ? word : 0;
      display = String(n);
      decVal  = n !== 0 ? `(${n})` : '';
    }

    const nonzero = display !== '0' && display !== '';
    const cls = ['mem-row', isPC ? 'pc-row' : '', nonzero ? 'nonzero' : ''].filter(Boolean).join(' ');

    html += `<div class="${cls}" id="mem-row-${i}" ondblclick="editMemCell(${i})">
      <span class="mem-addr${isPC ? ' active' : ''}">${String(i).padStart(2, '0')}</span>
      <span class="mem-val${nonzero ? ' nonzero' : ''}${isPC ? ' pc-val' : ''}">${escHtml(display)}</span>
      <span class="mem-dec${nonzero ? ' nonzero' : ''}">${decVal}</span>
    </div>`;
  }

  grid.innerHTML = html;

  const pcRow = document.getElementById(`mem-row-${PC}`);
  if (pcRow) pcRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function editMemCell(addr) {
  if (assembled && !halted) return; // no editing during live execution
  const row = document.getElementById(`mem-row-${addr}`);
  if (!row) return;

  const valSpan    = row.querySelector('.mem-val');
  const current    = memory[addr];
  const currentVal = typeof current === 'number' ? current : 0;

  const input       = document.createElement('input');
  input.className   = 'mem-edit';
  input.type        = 'number';
  input.value       = currentVal;
  valSpan.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const raw = input.value.trim();
    if (raw !== '' && /^-?\d+$/.test(raw)) {
      memory[addr] = parseInt(raw, 10);
    }
    renderMemory();
  };

  input.addEventListener('blur',    commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  commit();
    if (e.key === 'Escape') renderMemory();
  });
}

function scrollToAddr(val) {
  const addr = parseInt(val, 10);
  if (isNaN(addr) || addr < 0 || addr >= MEM_SIZE) return;
  const row = document.getElementById(`mem-row-${addr}`);
  if (row) row.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ═══════════════════════════════════════════════════════════════
//  OUTPUT LOG
// ═══════════════════════════════════════════════════════════════
function logOutput(msg) { addLog(msg, 'output');       }
function logPrompt(msg) { addLog(msg, 'input-prompt'); }
function logInfo(msg)   { addLog(msg, 'info');         }
function logError(msg)  { addLog('⚠ ' + msg, 'error'); }
function logHalt(msg)   { addLog(msg, 'halt');         }
function logWarn(msg)   { addLog('⚠ ' + msg, 'warn');  }

function addLog(msg, cls) {
  const div   = document.createElement('div');
  div.className = `log-line ${cls}`;
  div.innerHTML = `<span class="log-prefix">›</span><span>${escHtml(msg)}</span>`;
  outputLog.appendChild(div);
  outputLog.scrollTop = outputLog.scrollHeight;
}

function clearLog() { outputLog.innerHTML = ''; }

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ═══════════════════════════════════════════════════════════════
//  ERROR HANDLING
// ═══════════════════════════════════════════════════════════════
function runtimeError(msg) {
  halted  = true;
  running = false;
  stopRun();

  setBtn('btn-step', true);
  setBtn('btn-run',  true);
  setStatus('ERROR', 'error');
  document.getElementById('io-tag').textContent = 'ERROR';

  // Show in log
  logError(`RUNTIME ERROR at PC=${PC - 1}: ${msg}`);

  // Also show in modal for visibility
  document.getElementById('error-msg').textContent =
    `At instruction address ${PC - 1}:\n\n${msg}`;
  document.getElementById('error-modal').classList.add('show');
}

function closeErrorModal() {
  document.getElementById('error-modal').classList.remove('show');
}

// ═══════════════════════════════════════════════════════════════
//  UI HELPERS
// ═══════════════════════════════════════════════════════════════
function setBtn(id, disabled) {
  const el = document.getElementById(id);
  if (el) el.disabled = disabled;
}

function setStatus(text, cls) {
  const el = document.getElementById('cpu-status');
  if (!el) return;
  el.textContent = text;
  el.className   = `status-dot${cls ? ' ' + cls : ''}`;
}


resetSim();

editor.value = `READ 10      // read first number into MEM[10]
READ 11      // read second number into MEM[11]
LOAD 10      // load MEM[10] into accumulator
ADD 11       // accumulator = accumulator + MEM[11]
STOR 12      // store result into MEM[12]
WRIT 12      // print MEM[12] to screen
HALT 0       // end program`;

updateLineNumbers();
logInfo('VonSim ready. Click ASSEMBLE to load the example program.');
logInfo('Tip: Double-click any memory cell (after HALT) to edit it directly.');
