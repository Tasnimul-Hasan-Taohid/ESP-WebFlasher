/**
 * esptool.js
 * Web Serial implementation of the ESP ROM bootloader protocol.
 * Compatible with ESP8266, ESP32, ESP32-S2/S3/C3/C6/H2.
 *
 * Based on the open-source esptool protocol by Espressif Systems.
 * Reference: https://docs.espressif.com/projects/esptool/en/latest/esp32/
 */

'use strict';

// ─── Constants ─────────────────────────────────────────────────

const ESP_ROM_BAUD         = 115200;
const SLIP_END             = 0xC0;
const SLIP_ESC             = 0xDB;
const SLIP_ESC_END         = 0xDC;
const SLIP_ESC_ESC         = 0xDD;

// ROM Commands
const CMD_FLASH_BEGIN      = 0x02;
const CMD_FLASH_DATA       = 0x03;
const CMD_FLASH_END        = 0x04;
const CMD_MEM_BEGIN        = 0x05;
const CMD_MEM_END          = 0x06;
const CMD_MEM_DATA         = 0x07;
const CMD_SYNC             = 0x08;
const CMD_WRITE_REG        = 0x09;
const CMD_READ_REG         = 0x0A;
const CMD_SPI_ATTACH       = 0x0D;
const CMD_CHANGE_BAUDRATE  = 0x0F;
const CMD_FLASH_DEFL_BEGIN = 0x10;
const CMD_FLASH_DEFL_DATA  = 0x11;
const CMD_FLASH_DEFL_END   = 0x12;
const CMD_ERASE_FLASH      = 0xD0;

const FLASH_WRITE_SIZE     = 0x400;  // 1KB blocks
const FLASH_SECTOR_SIZE    = 0x1000; // 4KB sectors

// Chip detection magic values
const CHIP_DETECT_MAGIC = {
  0xfff0c101: 'ESP8266',
  0x00f01d83: 'ESP32',
  0x000007c6: 'ESP32-S2',
  0x6921506f: 'ESP32-S3',
  0x1b4f18f3: 'ESP32-S3',
  0x6f51306f: 'ESP32-C3',
  0x1b404f18: 'ESP32-C3',
  0x2ce0806f: 'ESP32-H2',
  0x0da1806f: 'ESP32-C6',
};

// ─── ESPTool class ─────────────────────────────────────────────

class ESPTool {
  constructor(logCallback) {
    this._port        = null;
    this._reader      = null;
    this._writer      = null;
    this._log         = logCallback || (() => {});
    this._connected   = false;
    this._chipName    = 'Unknown';
    this._buffer      = [];
    this._readTimeout = 3000;
  }

  // ── Public API ─────────────────────────────────────────────

  get connected()  { return this._connected; }
  get chipName()   { return this._chipName; }

  async connect(port) {
    this._port = port;
    await this._port.open({ baudRate: ESP_ROM_BAUD });
    this._writer = this._port.writable.getWriter();
    this._startReader();
    this._log('Serial port opened at ' + ESP_ROM_BAUD + ' baud', 'info');
    this._connected = true;
  }

  async disconnect() {
    this._connected = false;
    if (this._reader) {
      try { await this._reader.cancel(); } catch (_) {}
      this._reader = null;
    }
    if (this._writer) {
      try { this._writer.releaseLock(); } catch (_) {}
      this._writer = null;
    }
    if (this._port) {
      try { await this._port.close(); } catch (_) {}
      this._port = null;
    }
    this._log('Disconnected', 'info');
  }

  // Put chip into bootloader mode via DTR/RTS toggling
  async enterBootloader() {
    this._log('Entering bootloader mode...', 'info');
    // GPIO0 LOW + RST pulse
    await this._setDTRRTS(false, true);
    await this._sleep(100);
    await this._setDTRRTS(true, false);
    await this._sleep(50);
    await this._setDTRRTS(false, false);
    await this._sleep(500);
    this._buffer = [];
  }

  async sync() {
    this._log('Syncing with chip...', 'info');
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await this._sendCommand(CMD_SYNC, new Uint8Array([
          0x07, 0x07, 0x12, 0x20,
          ...new Array(32).fill(0x55)
        ]));
        this._log('Sync OK', 'success');
        return true;
      } catch (_) {
        await this._sleep(100);
      }
    }
    throw new Error('Failed to sync with chip. Check connection and try again.');
  }

  async detectChip() {
    try {
      const magic = await this._readReg(0x40001000);
      this._chipName = CHIP_DETECT_MAGIC[magic >>> 0] || 'Unknown ESP';
      this._log('Chip detected: ' + this._chipName, 'success');
      return this._chipName;
    } catch (_) {
      this._log('Could not detect chip (using board selection)', 'warn');
      return 'Unknown';
    }
  }

  async getFlashSize() {
    try {
      await this._sendCommand(CMD_SPI_ATTACH, new Uint8Array(8));
      const sfdpData = await this._readFlashId();
      const sizes = { 0x14: '1MB', 0x15: '2MB', 0x16: '4MB', 0x17: '8MB', 0x18: '16MB' };
      const sizeId = (sfdpData >> 16) & 0xFF;
      return sizes[sizeId] || 'Unknown';
    } catch (_) {
      return 'Unknown';
    }
  }

  async getMACAddress() {
    try {
      const mac0 = await this._readReg(0x3ff00050);
      const mac1 = await this._readReg(0x3ff00054);
      const mac = [
        0xac, 0x67, 0xb2,
        (mac1 >> 8) & 0xFF,
        mac0 >> 24,
        (mac0 >> 16) & 0xFF
      ];
      return mac.map(b => b.toString(16).padStart(2,'0')).join(':').toUpperCase();
    } catch (_) {
      return 'N/A';
    }
  }

  async changeBaudRate(baud) {
    const payload = new DataView(new ArrayBuffer(8));
    payload.setUint32(0, baud, true);
    payload.setUint32(4, 0, true);
    await this._sendCommand(CMD_CHANGE_BAUDRATE, new Uint8Array(payload.buffer));
    await this._sleep(50);

    // Re-open port at new baud
    if (this._reader) { try { await this._reader.cancel(); } catch(_){} }
    if (this._writer) { try { this._writer.releaseLock(); } catch(_){} }
    await this._port.close();
    await this._sleep(100);
    await this._port.open({ baudRate: baud });
    this._writer = this._port.writable.getWriter();
    this._buffer = [];
    this._startReader();
    this._log('Baud rate changed to ' + baud, 'info');
  }

  async eraseFlash(onProgress) {
    this._log('Erasing flash...', 'warn');
    if (onProgress) onProgress(0, 'Erasing flash...');
    await this._sendCommand(CMD_ERASE_FLASH, new Uint8Array(0), 30000);
    if (onProgress) onProgress(100, 'Erase complete');
    this._log('Flash erased', 'success');
  }

  async flashBinary(data, address, onProgress) {
    const totalSize  = data.length;
    const numBlocks  = Math.ceil(totalSize / FLASH_WRITE_SIZE);
    const eraseSize  = Math.ceil(totalSize / FLASH_SECTOR_SIZE) * FLASH_SECTOR_SIZE;

    this._log(`Flashing ${totalSize} bytes to 0x${address.toString(16)}...`, 'info');

    // Flash begin
    const beginPayload = new DataView(new ArrayBuffer(16));
    beginPayload.setUint32(0,  eraseSize,       true);
    beginPayload.setUint32(4,  numBlocks,        true);
    beginPayload.setUint32(8,  FLASH_WRITE_SIZE, true);
    beginPayload.setUint32(12, address,          true);

    await this._sendCommand(CMD_FLASH_BEGIN, new Uint8Array(beginPayload.buffer), 30000);
    this._log('Flash begin OK', 'info');

    // Write blocks
    let written = 0;
    const startTime = Date.now();

    for (let seq = 0; seq < numBlocks; seq++) {
      const blockStart = seq * FLASH_WRITE_SIZE;
      const blockEnd   = Math.min(blockStart + FLASH_WRITE_SIZE, totalSize);
      let   block      = data.slice(blockStart, blockEnd);

      // Pad last block
      if (block.length < FLASH_WRITE_SIZE) {
        const padded = new Uint8Array(FLASH_WRITE_SIZE).fill(0xFF);
        padded.set(block);
        block = padded;
      }

      const checksum  = this._checksum(block);
      const dataHdr   = new DataView(new ArrayBuffer(16));
      dataHdr.setUint32(0, block.length, true);
      dataHdr.setUint32(4, seq,          true);
      dataHdr.setUint32(8, 0,            true);
      dataHdr.setUint32(12, 0,           true);

      const payload = new Uint8Array(16 + block.length);
      payload.set(new Uint8Array(dataHdr.buffer), 0);
      payload.set(block, 16);

      await this._sendCommand(CMD_FLASH_DATA, payload, 5000, checksum);

      written += (blockEnd - blockStart);
      const pct      = Math.round((written / totalSize) * 100);
      const elapsed  = (Date.now() - startTime) / 1000;
      const speed    = elapsed > 0 ? Math.round(written / elapsed / 1024) : 0;
      const eta      = speed > 0 ? Math.round((totalSize - written) / (speed * 1024)) : 0;

      if (onProgress) {
        onProgress(pct, `${written} / ${totalSize} bytes  •  ${speed} KB/s  •  ETA ${eta}s`);
      }
    }

    // Flash end
    const endPayload = new DataView(new ArrayBuffer(4));
    endPayload.setUint32(0, 0, true); // 0 = reboot after flash
    await this._sendCommand(CMD_FLASH_END, new Uint8Array(endPayload.buffer));
    this._log('Flash end OK — device will reboot', 'success');
  }

  async reset() {
    this._log('Resetting device...', 'info');
    await this._setDTRRTS(false, true);
    await this._sleep(100);
    await this._setDTRRTS(false, false);
    await this._sleep(100);
    this._log('Device reset', 'success');
  }

  // ── Serial console passthrough ─────────────────────────────

  async sendText(text) {
    if (!this._writer) return;
    const encoded = new TextEncoder().encode(text);
    await this._writer.write(encoded);
  }

  // ── Private: SLIP framing ──────────────────────────────────

  _slipEncode(data) {
    const out = [SLIP_END];
    for (const byte of data) {
      if (byte === SLIP_END) { out.push(SLIP_ESC, SLIP_ESC_END); }
      else if (byte === SLIP_ESC) { out.push(SLIP_ESC, SLIP_ESC_ESC); }
      else { out.push(byte); }
    }
    out.push(SLIP_END);
    return new Uint8Array(out);
  }

  _slipDecode(data) {
    const out = [];
    let i = 0;
    while (i < data.length) {
      if (data[i] === SLIP_ESC) {
        i++;
        if (data[i] === SLIP_ESC_END)      out.push(SLIP_END);
        else if (data[i] === SLIP_ESC_ESC) out.push(SLIP_ESC);
      } else {
        out.push(data[i]);
      }
      i++;
    }
    return new Uint8Array(out);
  }

  // ── Private: Command I/O ───────────────────────────────────

  async _sendCommand(cmd, data, timeout = 3000, checksum = 0) {
    const size    = data.length;
    const packet  = new DataView(new ArrayBuffer(8 + size));
    packet.setUint8(0,  0x00);        // direction: host→esp
    packet.setUint8(1,  cmd);
    packet.setUint16(2, size, true);
    packet.setUint32(4, checksum, true);
    new Uint8Array(packet.buffer).set(data, 8);

    const encoded = this._slipEncode(new Uint8Array(packet.buffer));
    await this._writer.write(encoded);

    return await this._readResponse(cmd, timeout);
  }

  async _readResponse(cmd, timeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const packet = await this._readSlipPacket(deadline - Date.now());
      if (!packet) continue;
      const decoded = this._slipDecode(packet);
      if (decoded.length < 8) continue;
      const view = new DataView(decoded.buffer);
      if (view.getUint8(0) === 0x01 && view.getUint8(1) === cmd) {
        const status = decoded[decoded.length - 2];
        if (status !== 0) {
          throw new Error(`Command 0x${cmd.toString(16)} failed (status 0x${status.toString(16)})`);
        }
        return decoded.slice(8);
      }
    }
    throw new Error(`Timeout waiting for response to command 0x${cmd.toString(16)}`);
  }

  async _readSlipPacket(timeout) {
    const deadline = Date.now() + timeout;
    let packet = [];
    let inPacket = false;

    while (Date.now() < deadline) {
      if (this._buffer.length === 0) {
        await this._sleep(5);
        continue;
      }
      const byte = this._buffer.shift();
      if (byte === SLIP_END) {
        if (inPacket && packet.length > 0) {
          return new Uint8Array(packet);
        }
        inPacket = true;
        packet   = [];
      } else if (inPacket) {
        packet.push(byte);
      }
    }
    return null;
  }

  // ── Private: Reader loop ───────────────────────────────────

  _startReader() {
    this._reader = this._port.readable.getReader();
    const self   = this;
    (async () => {
      try {
        while (true) {
          const { value, done } = await self._reader.read();
          if (done) break;
          for (const byte of value) {
            self._buffer.push(byte);
            // Also emit to console if in passthrough mode
            if (self._onData) self._onData(byte);
          }
        }
      } catch (_) {}
    })();
  }

  // ── Private: Register reads ────────────────────────────────

  async _readReg(addr) {
    const payload = new DataView(new ArrayBuffer(4));
    payload.setUint32(0, addr, true);
    const resp = await this._sendCommand(CMD_READ_REG, new Uint8Array(payload.buffer));
    const view = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
    return view.getUint32(0, true);
  }

  async _readFlashId() {
    const payload = new Uint8Array([
      0x03, 0x00, 0x00, 0x00,  // data_len=3
      0x9F, 0x00, 0x00, 0x00,  // RDID cmd
    ]);
    try {
      const resp = await this._sendCommand(0x0A, payload);
      return new DataView(resp.buffer).getUint32(0, true);
    } catch(_) { return 0; }
  }

  // ── Private: DTR/RTS control ───────────────────────────────

  async _setDTRRTS(dtr, rts) {
    try {
      await this._port.setSignals({ dataTerminalReady: dtr, requestToSend: rts });
    } catch (_) {}
  }

  // ── Private: Checksum ──────────────────────────────────────

  _checksum(data, seed = 0xEF) {
    let cs = seed;
    for (const byte of data) cs ^= byte;
    return cs;
  }

  // ── Private: Sleep ────────────────────────────────────────

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
