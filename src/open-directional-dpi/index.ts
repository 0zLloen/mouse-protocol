/**
 * Open Directional DPI v1: a per-direction sensitivity profile (one gain per
 * 45° direction, 0.0625x to 4x) and the 64-byte Feature report that reads and
 * writes it. Not tied to one brand: the Glorious Series One Pro stock-firmware
 * patch and Zephyr builds answer the same packets. The Series One Pro's
 * detection stamp and receiver envelope are in ../glorious-classic/index.ts.
 *
 * Ported from open-directional-dpi (https://github.com/0zLloen/open-directional-dpi,
 * MIT, same author). Its spec/hid-protocol-v1.md (framing, commands,
 * capabilities) and spec/directional-dpi-v1.md §7 (the 28-byte profile) at
 * commit 1acd0fd are the reference:
 * https://github.com/0zLloen/open-directional-dpi/tree/1acd0fd/spec
 * Verified with that project's Linux hidraw tool on one retail Series One Pro
 * with the patch builds of 2026-11-13, the last one 21ea252: GET_CAPABILITIES,
 * GET_PROFILE, SET_PROFILE and SAVE_FLASH by cable and through the 2.4 GHz
 * receiver. docs/glorious-series-one-pro.md section 4 says which build showed
 * what. Not yet run over WebHID on hardware.
 *
 * Packet (body[n], report id 0 omitted):
 *   [0..1] 'D' 'P', [2] version 0x01, [3] status (0x00 in a request),
 *   [4] seq, [5] namespace 0xdf, [6] opcode, [7] slot (echoed, ignored),
 *   [8..61] payload, [62..63] CRC-16-CCITT (little-endian) over [0..61].
 * The answer echoes seq, namespace, opcode and slot; status 0xa1 means success.
 */

export const DDPI_PACKET_LENGTH = 64;
export const DDPI_PAYLOAD_LENGTH = 54;
export const DDPI_PROFILE_LENGTH = 28;
/** Packet and profile format version. */
export const DDPI_VERSION = 0x01;
export const DDPI_NAMESPACE = 0xdf;
/** Profile bytes 0..1, little-endian ("PD" on the wire). */
export const DDPI_PROFILE_MAGIC = 0x4450;
export const DDPI_STATUS_OK = 0xa1;

/**
 * Request seq range. Stock Glorious firmware rejects body[4] >= 5 before any
 * handler runs, and the Glorious receiver runs its own handlers only when
 * body[4] = 0, so a request can never trigger a stock or receiver command.
 */
export const DDPI_SEQ_MIN = 5;
export const DDPI_SEQ_MAX = 255;

/**
 * The commands used here. The reference also has RESET_DEFAULTS (0x05),
 * SET_ENABLED (0x06), SIMULATE_DELTA (0x07) and ENTER_BOOTLOADER (0x0f).
 */
export const DDPI_OPCODE = {
  getCapabilities: 0x01,
  getProfile: 0x02,
  /** Loads a profile into RAM and echoes it. */
  setProfile: 0x03,
  /** Stores the active profile and echoes it. A changed profile erases a flash page. */
  saveFlash: 0x04,
} as const;

/** Profile flag bit 0: apply the curve. Clear means 1.00x in every direction. */
export const DDPI_FLAG_ENABLED = 0x01;

/** GET_CAPABILITIES flag bits. */
export const DDPI_CAPABILITY_SAVE = 0x02;
export const DDPI_CAPABILITY_SENSOR_DPI = 0x40;
export const DDPI_CAPABILITY_CLOCK = 0x80;

export const DDPI_DPI_MIN = 50;
export const DDPI_DPI_MAX = 65535;
/** Gains are Q8.8: 0x0100 is 1.00x, 0x0010 is 0.0625x, 0x0400 is 4.00x. */
export const DDPI_Q8_8_ONE = 0x0100;
export const DDPI_Q8_8_MIN = 0x0010;
export const DDPI_Q8_8_MAX = 0x0400;

const STATUS_TEXT: Readonly<Record<number, string>> = {
  0xa2: "CRC or format error, or the save failed",
  0xa3: "unsupported",
  0xa4: "out of range",
};

export interface DdpiProfile {
  /** DDPI_FLAG_* bits. Bits 1..7 are described in the reference spec §7.1. */
  flags: number;
  /** Sensor DPI the profile was made for, 50..65535. */
  baseDpi: number;
  /** Q8.8, 0x0010..0x0400. */
  globalGainQ8_8: number;
  /**
   * Eight Q8.8 gains, 0x0010..0x0400. Index 0 is right (+X), then clockwise in
   * 45° steps (2 = toward the user, 6 = away), unless flag bit 3 stores them
   * counter-clockwise.
   */
  multipliersQ8_8: readonly number[];
  /** Low byte: travel window in counts. High byte: idle reset in 5 ms units. */
  reserved: number;
}

export interface DdpiCapabilities {
  /** DDPI_CAPABILITY_* bits. */
  flags: number;
  minDpi: number;
  maxDpi: number;
  minMultiplierQ8_8: number;
  maxMultiplierQ8_8: number;
  /** The sensor's current DPI, or null when the firmware does not report it. */
  sensorDpi: number | null;
  /** The firmware's millisecond clock (the one its idle reset uses), or null. */
  clockMs: number | null;
}

function whole(value: number, min: number, max: number, label: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer from ${min} to ${max}.`);
  }
}

function checkProfile(profile: DdpiProfile): void {
  whole(profile.flags, 0, 0xff, "Flags");
  whole(profile.baseDpi, DDPI_DPI_MIN, DDPI_DPI_MAX, "Base DPI");
  whole(profile.globalGainQ8_8, DDPI_Q8_8_MIN, DDPI_Q8_8_MAX, "Global gain");
  if (profile.multipliersQ8_8.length !== 8) throw new RangeError("A profile has 8 direction multipliers.");
  for (const gain of profile.multipliersQ8_8) whole(gain, DDPI_Q8_8_MIN, DDPI_Q8_8_MAX, "Direction multiplier");
  whole(profile.reserved, 0, 0xffff, "Reserved");
}

/** CRC-16-CCITT: polynomial 0x1021, initial value 0xffff, no reflection, no final XOR. */
export function ddpiCrc16(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** A gain such as 0.5 as Q8.8, rounded and clamped to 0x0010..0x0400. */
export function ddpiFloatToQ8_8(multiplier: number): number {
  return Math.max(DDPI_Q8_8_MIN, Math.min(DDPI_Q8_8_MAX, Math.round(multiplier * DDPI_Q8_8_ONE)));
}

export function ddpiClampDpi(dpi: number): number {
  return Math.max(DDPI_DPI_MIN, Math.min(DDPI_DPI_MAX, Math.round(dpi)));
}

/** The 28-byte profile: magic, version, values, then the CRC over bytes 0..25. Throws on out-of-range values. */
export function encodeDdpiProfile(profile: DdpiProfile): Uint8Array<ArrayBuffer> {
  checkProfile(profile);
  const bytes = new Uint8Array(DDPI_PROFILE_LENGTH);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, DDPI_PROFILE_MAGIC, true);
  bytes[2] = DDPI_VERSION;
  bytes[3] = profile.flags;
  view.setUint16(4, profile.baseDpi, true);
  view.setUint16(6, profile.globalGainQ8_8, true);
  profile.multipliersQ8_8.forEach((gain, index) => view.setUint16(8 + 2 * index, gain, true));
  view.setUint16(24, profile.reserved, true);
  view.setUint16(26, ddpiCrc16(bytes.subarray(0, 26)), true);
  return bytes;
}

/**
 * Reads the first 28 bytes. Throws unless the magic, version and CRC match and
 * the values are in range (the checks the firmware makes before loading one).
 */
export function decodeDdpiProfile(bytes: Uint8Array): DdpiProfile {
  if (bytes.length < DDPI_PROFILE_LENGTH) throw new RangeError(`A profile is ${DDPI_PROFILE_LENGTH} bytes, got ${bytes.length}.`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, DDPI_PROFILE_LENGTH);
  if (view.getUint16(0, true) !== DDPI_PROFILE_MAGIC || bytes[2] !== DDPI_VERSION) {
    throw new Error("Not an Open Directional DPI v1 profile.");
  }
  if (view.getUint16(26, true) !== ddpiCrc16(bytes.subarray(0, 26))) throw new Error("Open Directional DPI profile CRC mismatch.");
  const profile: DdpiProfile = {
    flags: bytes[3]!,
    baseDpi: view.getUint16(4, true),
    globalGainQ8_8: view.getUint16(6, true),
    multipliersQ8_8: Array.from({ length: 8 }, (_, index) => view.getUint16(8 + 2 * index, true)),
    reserved: view.getUint16(24, true),
  };
  checkProfile(profile);
  return profile;
}

/** A 64-byte request. `seq` must be 5..255 (see DDPI_SEQ_MIN); the payload is at most 54 bytes. */
export function buildDdpiRequest(
  opcode: number,
  seq: number,
  slot = 0,
  payload: Uint8Array = new Uint8Array(0),
): Uint8Array<ArrayBuffer> {
  whole(opcode, 0, 0xff, "Opcode");
  whole(seq, DDPI_SEQ_MIN, DDPI_SEQ_MAX, "Sequence number");
  whole(slot, 0, 0xff, "Slot");
  if (payload.length > DDPI_PAYLOAD_LENGTH) throw new RangeError(`The payload is at most ${DDPI_PAYLOAD_LENGTH} bytes.`);
  const packet = new Uint8Array(DDPI_PACKET_LENGTH);
  packet.set([0x44, 0x50, DDPI_VERSION, 0x00, seq, DDPI_NAMESPACE, opcode, slot]);
  packet.set(payload, 8);
  const crc = ddpiCrc16(packet.subarray(0, 62));
  packet[62] = crc & 0xff;
  packet[63] = crc >> 8;
  return packet;
}

/**
 * The payload (bytes 8..61) of the answer to the request with this seq and
 * opcode, or null when `body` is not that answer: another seq or opcode, the
 * previous answer a device still returns, or a Glorious receiver status byte.
 * Throws when it is the answer but its CRC does not match or its status is not
 * 0xa1.
 */
export function parseDdpiResponse(body: Uint8Array, seq: number, opcode: number): Uint8Array<ArrayBuffer> | null {
  if (body.length !== DDPI_PACKET_LENGTH || body[0] !== 0x44 || body[1] !== 0x50
    || body[4] !== seq || body[5] !== DDPI_NAMESPACE || body[6] !== opcode) return null;
  if ((body[62]! | (body[63]! << 8)) !== ddpiCrc16(body.subarray(0, 62))) {
    throw new Error("Open Directional DPI answer CRC mismatch.");
  }
  const status = body[3]!;
  if (status !== DDPI_STATUS_OK) {
    const text = STATUS_TEXT[status] ?? "unknown status";
    throw new Error(`Open Directional DPI command 0x${opcode.toString(16)} failed: 0x${status.toString(16)} (${text}).`);
  }
  return body.slice(8, 62);
}

/** Reads a GET_CAPABILITIES payload ("DP01" first). */
export function parseDdpiCapabilities(payload: Uint8Array): DdpiCapabilities {
  if (payload.length < 24 || String.fromCharCode(...payload.subarray(0, 4)) !== "DP01") {
    throw new Error("Not an Open Directional DPI v1 capabilities answer.");
  }
  const view = new DataView(payload.buffer, payload.byteOffset, 24);
  const flags = payload[7]!;
  const sensorDpi = view.getUint16(18, true);
  return {
    flags,
    minDpi: view.getUint16(8, true),
    maxDpi: view.getUint16(10, true),
    minMultiplierQ8_8: view.getUint16(12, true),
    maxMultiplierQ8_8: view.getUint16(14, true),
    sensorDpi: flags & DDPI_CAPABILITY_SENSOR_DPI && sensorDpi !== 0 ? sensorDpi : null,
    clockMs: flags & DDPI_CAPABILITY_CLOCK ? view.getUint32(20, true) : null,
  };
}
