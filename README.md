# ⚡ ESP WebFlasher

> Browser-based firmware uploader for ESP8266, ESP32, and all ESP variants. Drop a `.bin` file, click flash — done. No installation, no drivers, no Python, no IDE.

Built with the Web Serial API and the open-source ESP ROM bootloader protocol.

---

## Features

| Feature | Details |
|---|---|
| 🔌 Web Serial | Talks to your device directly from the browser — zero install |
| 🎛️ 8 Board Presets | ESP8266, Wemos D1 Mini, ESP32, S2, S3, C3, C6, H2 |
| 📦 Drop & Flash | Drag and drop `.bin` file or browse to select |
| ⚙️ Full Settings | Baud rate, flash mode, flash frequency, flash size, address |
| 🗑️ Erase Flash | Wipe the entire flash before or without flashing |
| 🔄 Reset | DTR/RTS hardware reset via Web Serial signals |
| 📊 Progress Bar | Live progress with KB/s speed and ETA |
| 🖥️ Serial Monitor | Built-in console after flashing — see device output |
| 💬 Serial Send | Type commands and send them to the device |
| 🔍 Chip Detection | Auto-detects chip type and MAC address on connect |
| 📁 Multi-Binary | Flash multiple `.bin` files to different addresses |
| 🌑 Dark UI | Clean dark interface, works on any screen size |

---

## Browser Support

| Browser | Support |
|---|---|
| Chrome 89+ | ✅ Full support |
| Edge 89+ | ✅ Full support |
| Opera 75+ | ✅ Full support |
| Firefox | ❌ Web Serial not supported |
| Safari | ❌ Web Serial not supported |

> **Must be desktop.** Mobile browsers don't support Web Serial even in Chrome.

---

## Supported Boards

| Board | Chip | Default Baud | Flash Address |
|---|---|---|---|
| ESP8266 Generic | ESP8266 | 115200 | 0x0 |
| Wemos D1 Mini | ESP8266 | 115200 | 0x0 |
| ESP32 DevKit | ESP32 | 921600 | 0x1000 |
| ESP32-S2 | ESP32-S2 | 921600 | 0x1000 |
| ESP32-S3 | ESP32-S3 | 921600 | 0x0 |
| ESP32-C3 | ESP32-C3 | 921600 | 0x0 |
| ESP32-C6 | ESP32-C6 | 921600 | 0x0 |
| ESP32-H2 | ESP32-H2 | 921600 | 0x0 |

---

## How to Use

### Quick Start

1. Open `index.html` in Chrome or Edge
2. Select your board from the grid
3. Drop your `.bin` firmware file onto the dropzone
4. Click **Connect Serial Port** → select your COM port
5. Click **Flash Firmware**
6. Watch the progress bar — done in seconds

### Settings

| Setting | Default | Notes |
|---|---|---|
| Baud Rate | 115200 / 921600 | Higher = faster flash. Some boards max at 460800 |
| Flash Mode | DIO | DIO works for most. QIO is faster but less compatible |
| Flash Frequency | 40MHz | 80MHz supported on ESP32 series |
| Flash Size | Auto Detect | Leave on auto unless you know your exact chip |
| Flash Address | Board default | 0x0 for ESP8266, 0x1000 for most ESP32 |

### Multi-Binary Flash

Some firmware packages ship as multiple `.bin` files (bootloader, partition table, app):

1. Load your main firmware in the dropzone
2. Click **+ Add another binary**
3. Set the address (e.g. `0x8000` for partition table)
4. Select the file
5. Flash — all files are written in sequence

### Erase Before Flash

Check **Erase flash before writing** to do a full chip wipe before flashing. Useful when:
- Switching firmware that uses different partition layouts
- Clearing EEPROM/NVS data
- Starting completely fresh

### Serial Monitor

After flashing, the tool automatically opens the serial monitor so you can see your device's output immediately. You can also:
- Type commands and send them
- Choose line ending (CRLF / LF / CR / None)
- Copy the full console log

---

## Running Locally

No build step needed — it's vanilla HTML/CSS/JS.

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/ESP-WebFlasher.git
cd ESP-WebFlasher

# Open in browser (must be served over HTTP, not file://)
# Option 1: Python
python3 -m http.server 8080

# Option 2: Node
npx serve .

# Option 3: VS Code Live Server extension
# Then open http://localhost:8080
```

> **Important:** The Web Serial API requires the page to be served over `https://` or `http://localhost`. Opening `index.html` directly as a `file://` URL will not work.

---

## Hosting on GitHub Pages

1. Push the repo to GitHub
2. Go to **Settings → Pages**
3. Set source to **main branch / root**
4. Your flasher is live at `https://yourusername.github.io/ESP-WebFlasher`

That's it — no server needed, works entirely in the browser.

---

## Project Structure

```
ESP-WebFlasher/
├── index.html    ← App shell and UI layout
├── style.css     ← Full dark theme with CSS variables
├── boards.js     ← Board definitions and default settings
├── esptool.js    ← ESP ROM bootloader protocol (SLIP framing)
└── app.js        ← Application logic and UI controller
```

---

## Architecture

```
Browser (Chrome/Edge)
│
├── Web Serial API
│     └── navigator.serial.requestPort()
│           └── port.open({ baudRate })
│
├── esptool.js  ← ROM protocol implementation
│     ├── SLIP framing (encode / decode)
│     ├── DTR/RTS bootloader entry
│     ├── Sync handshake (CMD_SYNC)
│     ├── Chip detection (READ_REG 0x40001000)
│     ├── Flash begin / data / end
│     ├── Baud rate negotiation
│     └── Erase flash
│
└── app.js  ← UI + orchestration
      ├── Board selection
      ├── File drag & drop
      ├── Progress reporting
      ├── Serial console monitor
      └── Multi-binary flash
```

---

## Troubleshooting

**"Web Serial API not supported"**
- Use Chrome or Edge on desktop (version 89 or later)
- Firefox and Safari do not support Web Serial

**Device not appearing in port list**
- Install the correct USB driver:
  - CP2102 chips → [Silicon Labs CP210x driver](https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers)
  - CH340 chips → [CH340 driver](http://www.wch-ic.com/downloads/CH341SER_ZIP.html)
  - FTDI chips → [FTDI VCP driver](https://ftdichip.com/drivers/vcp-drivers/)
- Unplug and replug the device
- Try a different USB cable (data cable, not charge-only)

**"Failed to sync with chip"**
- The board may not be in bootloader mode
  - ESP8266/ESP32: Hold BOOT/GPIO0, press RESET, release RESET, release BOOT
  - Most modern boards enter bootloader automatically via DTR/RTS
- Try a lower baud rate (115200)
- Check you have the right COM port selected

**Flash fails partway through**
- Try a lower baud rate — some cables don't support 921600
- Use a shorter USB cable
- Try a powered USB hub if the device is losing power
- Enable "Erase flash before writing" and retry

**Device not appearing in serial monitor**
- Set the console baud rate to match your firmware's `Serial.begin()` value
- Common values: 115200, 9600, 74880 (ESP8266 boot messages)
- Click Reset to restart the device

**ESP32 shows wrong flash address**
- ESP32 app binary goes to `0x10000`, not `0x0`
- Bootloader goes to `0x1000`, partition table to `0x8000`
- Use the board preset which sets the correct default automatically

---

## Comparison with Alternatives

| Tool | Install | Browser | Offline | Multi-bin |
|---|---|---|---|---|
| **ESP WebFlasher** | ❌ None | ✅ Yes | ✅ Yes | ✅ Yes |
| Arduino IDE | ✅ Full IDE | ❌ No | ✅ Yes | ❌ No |
| esptool.py | ✅ Python | ❌ No | ✅ Yes | ✅ Yes |
| ESP Flash Tool | ✅ Windows app | ❌ No | ✅ Yes | ✅ Yes |
| Adafruit ESPTool | ❌ None | ✅ Yes | ❌ No | ❌ No |

---
