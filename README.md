# Deye Glass

Desktop widget for Windows that shows your solar inverter status at a glance: battery charge, power flow, grid state, 24-hour chart.

![Deye Glass widget](.github/screenshot.png)

---

## Download

**[→ Latest release: Deye-Glass.exe](https://github.com/Coresmith-UA/deye-glass/releases/latest)**

Single portable EXE. No installer, no Node.js required.

---

## Setup

### 1. Get API credentials

The widget uses the **official Deye developer API**, not a browser session token. You need a free developer account.

1. Go to **[developer.deyecloud.com](https://developer.deyecloud.com)**
2. Log in with your regular Deye Cloud account (the same one you use in the phone app)
3. Create an application — you'll get an **App ID** and **App Secret**
4. Find your **Station ID** in the Deye Cloud app (Plant → Plant Details)

### 2. Configure the widget

1. Place `Deye-Glass.exe` in any writable folder (not `Program Files`)
2. Run it — the widget appears on the desktop
3. **Right-click → Settings…**
4. Fill in: App ID, App Secret, your account email and password, Station ID
5. Click **Test connection** — you should see your battery SOC
6. Click **Save**

The widget fetches a token automatically and renews it before it expires. You never enter a token by hand.

### 3. Optional: start with Windows

Right-click the widget → **Start with Windows** ✓

---

## Features

- **Real-time readings**: battery SOC (ring + %, kWh estimate), battery power, grid power, home load
- **Grid outage detection**: alert sound + red state when grid goes down, green when it comes back
- **24-hour chart**: filled from cloud history on startup — no gaps after sleep or restart
- **Day statistics**: time with / without grid, charging time, on-battery time — shown since midnight
- **Two layouts**: full (640×580) and compact (440×220), scalable 50–150%
- **Encrypted credentials**: App Secret and password stored via Windows DPAPI — never plain text on disk
- **Three languages**: English, Русский, Українська
- **Tray icon**: SOC arc + number in the state colour, tooltip with status and duration

---

## Controls

| Action | Result |
|---|---|
| Drag the widget surface | Move |
| Double-click | Toggle compact / full layout |
| Right-click | Open menu |
| Hover top edge | Show toolbar: 🔇 mute · 📌 pin · ▱ resize · ⋯ menu · − hide |
| Tray icon double-click | Show widget |
| Esc | Hide to tray |
| F5 | Force refresh |

**Pin** locks the widget in place: no dragging, no hiding, no closing by accident. Exit still works via the menu.

---

## Sound alerts

Two WAV files are bundled inside the EXE (`sounds/grid_lost.wav`, `sounds/grid_back.wav`). They play automatically on grid state changes.

To use your own files: **Settings… → Grid lost / Grid back → Browse…**

Mute: the 🔇 button, the menu, or Settings.

---

## Build from source

Requires **Node.js LTS**.

```bash
cd electron
npm install
npm start          # run from source
npm test           # 80 tests, no network needed
npm run dist       # build portable EXE → electron/dist/Deye-Glass.exe
```

---

## Credentials & security

- App Secret and account password are encrypted with **Windows DPAPI** before being written to `config.ini`
- They are never shown back in the UI after saving
- Leaving a field empty on save means "keep the stored value" — you can change the Station ID without retyping your password
- A `config.ini` from another machine cannot be decrypted — DPAPI binds to the user and machine

---

Developed by [Coresmith](https://github.com/Coresmith-UA)
