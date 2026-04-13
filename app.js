'use strict';

// ─── State ─────────────────────────────────────────────────────
let esp         = null;
let port        = null;
let firmwareFile = null;
let extraFiles  = [];   // [{file, address}]
let selectedBoard = BOARDS[0];
let consoleMode = false; // true = serial monitor, false = flashing mode
let consoleReader = null;

// ─── DOM refs ──────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const boardGrid      = $('boardGrid');
const connectBtn     = $('connectBtn');
const disconnectBtn  = $('disconnectBtn');
const flashBtn       = $('flashBtn');
const eraseBtn       = $('eraseBtn');
const resetBtn       = $('resetBtn');
const portInfo       = $('portInfo');
const portLabel      = $('portLabel');
const progressArea   = $('progressArea');
const progressBar    = $('progressBar');
const progressLabel  = $('progressLabel');
const progressPct    = $('progressPct');
const progressMeta   = $('progressMeta');
const consoleOutput  = $('consoleOutput');
const consoleInput   = $('consoleInput');
const sendBtn        = $('sendBtn');
const deviceInfo     = $('deviceInfo');
const deviceInfoGrid = $('deviceInfoGrid');
const dropzone       = $('dropzone');
const fileInput      = $('fileInput');
const fileInfo       = $('fileInfo');
const fileName       = $('fileName');
const fileSize       = $('fileSize');
const browseBtn      = $('browseBtn');
const clearFile      = $('clearFile');
const addFileBtn     = $('addFileBtn');
const extraFilesDiv  = $('extraFiles');
const browserWarning = $('browserWarning');

// ─── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  checkBrowserSupport();
  buildBoardGrid();
  bindEvents();
  log('ESP WebFlasher ready', 'dim');
});

// ─── Browser check ─────────────────────────────────────────────
function checkBrowserSupport() {
  if (!('serial' in navigator)) {
    browserWarning.style.display = 'block';
    connectBtn.disabled = true;
    log('⚠ Web Serial API not supported. Use Chrome or Edge 89+.', 'error');
  }
}

// ─── Board grid ────────────────────────────────────────────────
function buildBoardGrid() {
  boardGrid.innerHTML = '';
  BOARDS.forEach(board => {
    const card = document.createElement('div');
    card.className = 'board-card' + (board.id === selectedBoard.id ? ' selected' : '');
    card.innerHTML = `
      <span class="board-card-name">${board.name}</span>
      <span class="board-card-chip">${board.chip}</span>
      <span class="board-card-desc">${board.desc}</span>
    `;
    card.addEventListener('click', () => selectBoard(board));
    boardGrid.appendChild(card);
  });
}

function selectBoard(board) {
  selectedBoard = board;
  buildBoardGrid();
  // Apply board defaults
  $('baudRate').value  = board.baud;
  $('flashMode').value = board.flashMode;
  $('flashFreq').value = board.flashFreq;
  $('flashSize').value = board.flashSize;
  $('flashAddr').value = board.flashAddr;
  log(`Board selected: ${board.name} (${board.chip})`, 'info');
}

// ─── Events ────────────────────────────────────────────────────
function bindEvents() {
  connectBtn   .addEventListener('click', handleConnect);
  disconnectBtn.addEventListener('click', handleDisconnect);
  flashBtn     .addEventListener('click', handleFlash);
  eraseBtn     .addEventListener('click', handleErase);
  resetBtn     .addEventListener('click', handleReset);
  browseBtn    .addEventListener('click', () => fileInput.click());
  clearFile    .addEventListener('click', clearFirmware);
  addFileBtn   .addEventListener('click', addExtraFile);
  sendBtn      .addEventListener('click', handleSend);
  $('clearConsole').addEventListener('click', () => { consoleOutput.innerHTML = ''; });
  $('copyConsole') .addEventListener('click', copyConsole);

  fileInput.addEventListener('change', e => {
    if (e.target.files[0]) loadFirmware(e.target.files[0]);
  });

  // Drag & drop
  dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) loadFirmware(file);
  });
  dropzone.addEventListener('click', e => {
    if (e.target === dropzone || e.target.classList.contains('dropzone-icon') ||
        e.target.classList.contains('dropzone-text') || e.target.tagName === 'svg' ||
        e.target.tagName === 'path') {
      fileInput.click();
    }
  });

  // Console input
  consoleInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') handleSend();
  });
}

// ─── Connect ───────────────────────────────────────────────────
async function handleConnect() {
  try {
    port = await navigator.serial.requestPort();
    log('Port selected — opening...', 'info');

    esp = new ESPTool((msg, type) => log(msg, type));
    await esp.connect(port);

    portInfo.style.display  = 'flex';
    connectBtn.style.display = 'none';
    eraseBtn.disabled  = false;
    resetBtn.disabled  = false;
    consoleInput.disabled = false;
    sendBtn.disabled   = false;

    log('Entering bootloader mode...', 'info');
    await esp.enterBootloader();

    log('Syncing...', 'info');
    await esp.sync();

    const chip = await esp.detectChip();
    portLabel.textContent = chip + ' connected';

    const mac = await esp.getMACAddress();

    showDeviceInfo({
      'Chip':      chip,
      'MAC':       mac,
      'Port':      'Web Serial',
      'Baud':      $('baudRate').value,
    });

    updateFlashBtn();
    log('Ready to flash!', 'success');

  } catch (err) {
    log('Connect failed: ' + err.message, 'error');
    esp = null;
  }
}

// ─── Disconnect ────────────────────────────────────────────────
async function handleDisconnect() {
  if (consoleReader) {
    try { await consoleReader.cancel(); } catch(_) {}
    consoleReader = null;
  }
  if (esp) {
    await esp.disconnect();
    esp = null;
  }
  port = null;

  portInfo.style.display   = 'none';
  connectBtn.style.display = '';
  flashBtn.disabled  = true;
  eraseBtn.disabled  = true;
  resetBtn.disabled  = true;
  consoleInput.disabled = true;
  sendBtn.disabled   = true;
  deviceInfo.style.display = 'none';
  progressArea.style.display = 'none';
  log('Disconnected', 'dim');
}

// ─── Flash ─────────────────────────────────────────────────────
async function handleFlash() {
  if (!esp || !firmwareFile) return;

  flashBtn.disabled = true;
  eraseBtn.disabled = true;

  try {
    const baud = parseInt($('baudRate').value);
    if (baud !== ESP_ROM_BAUD) {
      log(`Switching to ${baud} baud...`, 'info');
      await esp.changeBaudRate(baud);
    }

    // Erase first if checkbox checked
    if ($('eraseFlash').checked) {
      progressArea.style.display = 'block';
      await esp.eraseFlash(updateProgress);
    }

    // Read main firmware
    const mainAddr = parseInt($('flashAddr').value, 16) || 0x0;
    const mainData = await readFile(firmwareFile);

    progressArea.style.display = 'block';
    log(`Flashing ${firmwareFile.name} (${formatBytes(mainData.length)}) to 0x${mainAddr.toString(16)}...`, 'info');

    await esp.flashBinary(mainData, mainAddr, updateProgress);
    log(`✓ ${firmwareFile.name} flashed successfully`, 'success');

    // Flash extra files
    for (const ef of extraFiles) {
      if (!ef.file || !ef.address) continue;
      const data = await readFile(ef.file);
      const addr = parseInt(ef.address, 16);
      log(`Flashing extra: ${ef.file.name} to 0x${addr.toString(16)}`, 'info');
      await esp.flashBinary(data, addr, updateProgress);
      log(`✓ ${ef.file.name} done`, 'success');
    }

    log('🎉 All done! Device is rebooting...', 'success');
    updateProgress(100, 'Flash complete!');

    // Start console monitor after flash
    startConsoleMonitor();

  } catch (err) {
    log('Flash error: ' + err.message, 'error');
  } finally {
    flashBtn.disabled = false;
    eraseBtn.disabled = false;
  }
}

// ─── Erase only ────────────────────────────────────────────────
async function handleErase() {
  if (!esp) return;
  if (!confirm('Erase entire flash? All data will be lost.')) return;

  flashBtn.disabled = true;
  eraseBtn.disabled = true;
  progressArea.style.display = 'block';

  try {
    await esp.eraseFlash(updateProgress);
    log('Flash erased successfully', 'success');
  } catch (err) {
    log('Erase failed: ' + err.message, 'error');
  } finally {
    flashBtn.disabled = false;
    eraseBtn.disabled = false;
  }
}

// ─── Reset ─────────────────────────────────────────────────────
async function handleReset() {
  if (!esp) return;
  try {
    await esp.reset();
    startConsoleMonitor();
  } catch (err) {
    log('Reset failed: ' + err.message, 'error');
  }
}

// ─── Console monitor ───────────────────────────────────────────
async function startConsoleMonitor() {
  if (!port || !port.readable) return;
  log('── Serial monitor active ──', 'dim');

  const decoder = new TextDecoder();
  consoleMode   = true;

  try {
    // Re-open at console baud
    const consoleBaud = parseInt($('consoleBaud').value) || 115200;
    if (esp) { await esp.disconnect(); }

    await port.open({ baudRate: consoleBaud });
    const reader = port.readable.getReader();
    consoleReader = reader;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      logRaw(text);
    }
  } catch (err) {
    if (err.name !== 'NetworkError') {
      log('Console closed: ' + err.message, 'dim');
    }
  }
}

// ─── Serial send ───────────────────────────────────────────────
async function handleSend() {
  const text = consoleInput.value;
  if (!text || !port) return;
  const ending = $('lineEnding').value;
  const full   = text + ending;

  try {
    if (esp) {
      await esp.sendText(full);
    } else if (port.writable) {
      const writer = port.writable.getWriter();
      await writer.write(new TextEncoder().encode(full));
      writer.releaseLock();
    }
    log('→ ' + text, 'tx');
    consoleInput.value = '';
  } catch (err) {
    log('Send failed: ' + err.message, 'error');
  }
}

// ─── Firmware file ─────────────────────────────────────────────
function loadFirmware(file) {
  if (!file.name.endsWith('.bin')) {
    log('Only .bin files are supported', 'error');
    return;
  }
  firmwareFile = file;
  dropzone.style.display  = 'none';
  fileInfo.style.display  = 'flex';
  fileName.textContent    = file.name;
  fileSize.textContent    = formatBytes(file.size);
  updateFlashBtn();
  log(`Firmware loaded: ${file.name} (${formatBytes(file.size)})`, 'info');
}

function clearFirmware() {
  firmwareFile = null;
  dropzone.style.display = '';
  fileInfo.style.display = 'none';
  fileInput.value = '';
  updateFlashBtn();
}

function updateFlashBtn() {
  flashBtn.disabled = !(esp && firmwareFile);
}

// ─── Multi-file support ────────────────────────────────────────
function addExtraFile() {
  const idx = extraFiles.length;
  extraFiles.push({ file: null, address: '0x0' });

  const row   = document.createElement('div');
  row.className = 'extra-file-row';
  row.id = `erow-${idx}`;

  const addrInput = document.createElement('input');
  addrInput.type        = 'text';
  addrInput.placeholder = '0x0';
  addrInput.value       = '0x0';
  addrInput.addEventListener('change', e => { extraFiles[idx].address = e.target.value; });

  const fi   = document.createElement('input');
  fi.type    = 'file'; fi.accept = '.bin'; fi.hidden = true;
  fi.id      = `efi-${idx}`;

  const lbl  = document.createElement('label');
  lbl.htmlFor = `efi-${idx}`;
  lbl.textContent = 'Click to choose .bin file';

  fi.addEventListener('change', e => {
    if (e.target.files[0]) {
      extraFiles[idx].file   = e.target.files[0];
      lbl.textContent = e.target.files[0].name;
    }
  });

  const rmBtn = document.createElement('button');
  rmBtn.className = 'clear-btn'; rmBtn.textContent = '✕';
  rmBtn.addEventListener('click', () => {
    extraFiles.splice(idx, 1);
    row.remove();
  });

  row.appendChild(addrInput);
  row.appendChild(fi);
  row.appendChild(lbl);
  row.appendChild(rmBtn);
  extraFilesDiv.appendChild(row);
}

// ─── Progress ──────────────────────────────────────────────────
function updateProgress(pct, meta) {
  progressBar.style.width   = pct + '%';
  progressPct.textContent   = pct + '%';
  progressLabel.textContent = pct < 100 ? 'Flashing...' : '✓ Done!';
  if (meta) progressMeta.textContent = meta;
}

// ─── Device info panel ─────────────────────────────────────────
function showDeviceInfo(info) {
  deviceInfo.style.display = 'block';
  deviceInfoGrid.innerHTML = '';
  for (const [k, v] of Object.entries(info)) {
    deviceInfoGrid.innerHTML += `
      <div class="di-card">
        <div class="di-label">${k}</div>
        <div class="di-value">${v}</div>
      </div>`;
  }
}

// ─── Console log ───────────────────────────────────────────────
function log(msg, type = 'dim') {
  const ts   = new Date().toLocaleTimeString('en', { hour12: false });
  const line = document.createElement('div');
  line.className = `console-line ${type}`;
  line.innerHTML = `<span class="ts">${ts}</span>${escapeHTML(msg)}`;
  consoleOutput.appendChild(line);
  if ($('autoScroll').checked) {
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
  }
}

let _rawBuf = '';
function logRaw(text) {
  _rawBuf += text;
  const lines = _rawBuf.split('\n');
  _rawBuf = lines.pop();
  lines.forEach(line => {
    if (!line.trim()) return;
    const div = document.createElement('div');
    div.className = 'console-line rx';
    div.textContent = line;
    consoleOutput.appendChild(div);
  });
  if ($('autoScroll').checked) {
    consoleOutput.scrollTop = consoleOutput.scrollHeight;
  }
}

function copyConsole() {
  const text = [...consoleOutput.querySelectorAll('.console-line')]
    .map(l => l.textContent).join('\n');
  navigator.clipboard.writeText(text).then(() => log('Console copied', 'dim'));
}

// ─── Helpers ───────────────────────────────────────────────────
function readFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(new Uint8Array(e.target.result));
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

function formatBytes(bytes) {
  if (bytes < 1024)        return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function escapeHTML(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
