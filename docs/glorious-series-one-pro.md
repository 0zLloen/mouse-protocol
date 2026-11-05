# Glorious Forge Series One Pro Wireless (`258a:2018` / `258a:2031`)

This document records the hardware-verified USB HID configuration and resident Compx nRF52840 bootloader protocol for the **Glorious Forge Series One Pro Wireless** gaming mouse (`FCC ID: 2AXP2-SP22`, PCB `CM2852-BAMF 20220516`).

---

## 1. USB Identification & HID Interfaces

| Mode | VID:PID | USB Revision | Interface 2 Config Channel |
| :--- | :--- | :--- | :--- |
| **Wired Mouse Application** | `258a:2018` | `1.01` | Usage Page `0xFFFF`, Usage `0x0000`, unnumbered 64-byte Feature report (Report ID `0x00`) |
| **Wireless 2.4 GHz Receiver Application** | `258a:2031` | `1.00` | Usage Page `0xFFFF`, Usage `0x0000`, unnumbered 64-byte Feature report (Report ID `0x00`) |
| **Wired Mouse Resident Bootloader** | `258a:2103` | `1.00` | Usage Page `0xFFFF`, Usage `0x0000`, unnumbered 64-byte Feature report (Report ID `0x00`) |
| **Wireless Receiver Resident Bootloader** | `258a:2113` | `1.00` | Usage Page `0xFFFF`, Usage `0x0000`, unnumbered 64-byte Feature report (Report ID `0x00`) |

---

## 2. Application Feature Report Frame Layout (`258a:2018` / `258a:2031`)

All offsets below (`body[0..63]`) omit the leading Report ID byte (`0x00`).

### 2.1 Firmware Version Read (`0x00, 0x81`)

- **Request (`SET_REPORT` Feature `0x00`)**:
  ```text
  body[0..1] = 00 00
  body[2]    = 0x00 (device target; 0x02 for wireless mouse via receiver)
  body[3]    = 0x06 (length)
  body[4]    = 0x00 (system bank)
  body[5]    = 0x81 (firmware version register)
  ```
- **Reply (`GET_REPORT` Feature `0x00` after ~25 ms)**:
  ```text
  body[0]     = 0xa1 (status OK)
  body[4]     = 0x00
  body[5]     = 0x81
  body[6..9]  = major, minor, patch, build (e.g. 01 00 00 00 -> v1.0.0.0)
  body[10..11]= big-endian uint16 USB Product ID (20 18 -> 0x2018)
  ```

### 2.2 Battery Status Read (`0x00, 0x83`)

- **Request**: `body[2] = 0x02, body[3] = 0x02, body[4] = 0x00, body[5] = 0x83`
- **Reply**: `body[0] = status (0xa1 Normal, 0xa4 Asleep, 0xa0 WakingUp), body[5] = 0x83, body[6] = charging (0 or 1), body[7] = percent (1..100)`

### 2.3 Enter Resident USB HID Bootloader (`0x00, 0x00, 0xB0`)

- **Request (`C52840Dongle::SetBLDeviceMode`)**:
  ```text
  body[3] = 0x02 (length)
  body[4] = 0x00 (system bank)
  body[5] = 0x00 (register 0x00)
  body[6] = 0xb0 (bootloader magic command)
  ```
- **Firmware Behavior**: Writes `0xA55AA55A` to `*(volatile uint32_t *)0x2003FFFC` (top 4 bytes of nRF52840 256 KB SRAM) and triggers `NVIC_SystemReset()`. The resident 24 KB bootloader (`0x00000000`–`0x00005FFF`) detects `0xA55AA55A` and enumerates on USB as `258a:2103` (mouse) or `258a:2113` (receiver).

---

## 3. Resident Compx USB HID Bootloader Protocol (`258a:2103` / `258a:2113`)

| Command | `body[3]` (Len) | `body[4]` | `body[5]` (Cmd) | `body[6..10]` | `body[11..63]` | Behavior / Reply |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`GetBLFW`** | `0x06` | `0xB0` | `0x80` | `00..` | `00..` | Returns `body[0] = 0xA1` and 4-byte bootloader version at `body[8..11]` (`b0 01 00 00`). |
| **`Erase`** | `0x08` | `0xB0` | `0x01` | `00..` | `00..` | Erases application flash partition (`0x00006000`+ on mouse, `0x00007000`+ on receiver). Preserves bootloader (`0x0000..0x5FFF`) and factory RF pairing (`0x00088000`). |
| **`Program`** | `len + 5` | `0xB0` | `0x02` | `body[6] = len` (`<= 32`)<br>`body[7..10] = addr` (BE `u32`) | `len` bytes of `data ^ 0x55` | Bootloader XORs each payload byte with `0x55` and writes to `addr`. |
| **`VerifyByAddress`** | `0x20` | `0xB0` | `0x83` | `body[6] = len` (`<= 32`)<br>`body[7..10] = addr` (BE `u32`) | `00..` | Returns `body[0] = 0xA1` and `len` bytes from `addr` XORed with `0x55` at `body[11..11+len-1]`. Rejects addresses outside application partition (e.g. `0x00000000`) with `0xA2`. |
| **`Exit`** | `0x01` | `0xB0` | `0x04` | `body[6] = 0x01` | `00..` | Marks application valid and resets into application (`0x00006000`). |
