import assert from "node:assert/strict";
import test from "node:test";

import {
  DDPI_OPCODE,
  buildDdpiRequest,
  ddpiClampDpi,
  ddpiCrc16,
  ddpiFloatToQ8_8,
  decodeDdpiProfile,
  encodeDdpiProfile,
  parseDdpiCapabilities,
  parseDdpiResponse,
  type DdpiProfile,
} from "./index.ts";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const fromHex = (text: string) => Uint8Array.from(Buffer.from(text, "hex"));

// Serialized by the C reference (open-directional-dpi tests/vectors/scale_vectors.json).
const C_ASYMMETRIC = "504401014006000100012c0180015401e600c800aa00d20010006f9a";
const C_EXTREME_45000_DPI = "50440109c8af00040004100010000004100000040004100000009e4d";

// GET_CAPABILITIES payload in the layout patch build 21ea252 answers (flags 0xfa:
// save, bootloader, travel window, 2x2, sensor DPI, clock) at 800 DPI, clock 120000 ms.
const CAPABILITIES_21EA252 = fromHex("44503031010100fa3200ffff1000000410802003c0d40100");

/** An answer from the device: the request header, status, payload and CRC. */
function answer(request: Uint8Array, payload: Uint8Array, status = 0xa1): Uint8Array {
  const body = new Uint8Array(64);
  body.set(request.subarray(0, 8));
  body[3] = status;
  body.set(payload, 8);
  const crc = ddpiCrc16(body.subarray(0, 62));
  body[62] = crc & 0xff;
  body[63] = crc >> 8;
  return body;
}

test("CRC-16-CCITT check value", () => {
  assert.equal(ddpiCrc16(new TextEncoder().encode("123456789")), 0x29b1);
});

test("profiles encode and decode byte for byte like the C reference", () => {
  const profile = decodeDdpiProfile(fromHex(C_ASYMMETRIC));
  assert.deepEqual(profile, {
    flags: 0x01,
    baseDpi: 1600,
    globalGainQ8_8: 256,
    multipliersQ8_8: [256, 300, 384, 340, 230, 200, 170, 210],
    reserved: 0x0010,
  });
  assert.equal(hex(encodeDdpiProfile(profile)), C_ASYMMETRIC);
  const extreme = decodeDdpiProfile(fromHex(C_EXTREME_45000_DPI));
  assert.equal(extreme.baseDpi, 45000);
  assert.equal(hex(encodeDdpiProfile(extreme)), C_EXTREME_45000_DPI);
});

test("profiles with a bad CRC, magic or value are rejected", () => {
  const bytes = fromHex(C_ASYMMETRIC);
  const flipped = bytes.slice();
  flipped[10]! ^= 1;
  assert.throws(() => decodeDdpiProfile(flipped), /CRC/);
  const badMagic = bytes.slice();
  badMagic[0] = 0;
  assert.throws(() => decodeDdpiProfile(badMagic), /Not an Open Directional DPI/);
  assert.throws(() => decodeDdpiProfile(bytes.subarray(0, 27)), /28 bytes/);

  // A correctly signed profile whose gain is below 0.0625x.
  const lowGain = bytes.slice();
  lowGain[8] = 0x0f;
  lowGain[9] = 0x00;
  const crc = ddpiCrc16(lowGain.subarray(0, 26));
  lowGain[26] = crc & 0xff;
  lowGain[27] = crc >> 8;
  assert.throws(() => decodeDdpiProfile(lowGain), /Direction multiplier/);

  const valid: DdpiProfile = decodeDdpiProfile(bytes);
  assert.throws(() => encodeDdpiProfile({ ...valid, baseDpi: 49 }), /Base DPI/);
  assert.throws(() => encodeDdpiProfile({ ...valid, globalGainQ8_8: 1025 }), /Global gain/);
  assert.throws(() => encodeDdpiProfile({ ...valid, multipliersQ8_8: [256, 256] }), /8 direction/);
  assert.throws(() => encodeDdpiProfile({ ...valid, multipliersQ8_8: [256, 256, 256, 256, 256, 256, 256, 1.5] }), /Direction/);
});

test("gain and DPI helpers clamp to the protocol range", () => {
  assert.deepEqual([0.5, 1, 4, 10, 0].map(ddpiFloatToQ8_8), [128, 256, 1024, 1024, 16]);
  assert.deepEqual([10, 800.4, 70000].map(ddpiClampDpi), [50, 800, 65535]);
});

test("requests are framed with seq, namespace, opcode and CRC", () => {
  const profile = fromHex(C_ASYMMETRIC);
  const request = buildDdpiRequest(DDPI_OPCODE.setProfile, 5, 0, profile);
  assert.equal(request.length, 64);
  assert.equal(hex(request.subarray(0, 8)), "4450010005df0300");
  assert.equal(hex(request.subarray(8, 36)), C_ASYMMETRIC);
  assert.equal(request[62]! | (request[63]! << 8), ddpiCrc16(request.subarray(0, 62)));
  assert.throws(() => buildDdpiRequest(DDPI_OPCODE.getProfile, 4), /Sequence number/);
  assert.throws(() => buildDdpiRequest(DDPI_OPCODE.getProfile, 256), /Sequence number/);
  assert.throws(() => buildDdpiRequest(DDPI_OPCODE.setProfile, 5, 0, new Uint8Array(55)), /54 bytes/);
});

test("only the answer to this seq and opcode is accepted, with a valid CRC and status", () => {
  const request = buildDdpiRequest(DDPI_OPCODE.getProfile, 9);
  const profile = fromHex(C_ASYMMETRIC);
  const ok = answer(request, profile);
  assert.equal(hex(parseDdpiResponse(ok, 9, DDPI_OPCODE.getProfile)!.subarray(0, 28)), C_ASYMMETRIC);

  assert.equal(parseDdpiResponse(ok, 8, DDPI_OPCODE.getProfile), null, "a previous seq");
  assert.equal(parseDdpiResponse(ok, 9, DDPI_OPCODE.setProfile), null, "another opcode");
  assert.equal(parseDdpiResponse(ok.subarray(0, 63), 9, DDPI_OPCODE.getProfile), null, "short");
  assert.equal(parseDdpiResponse(Uint8Array.of(0xa4, ...ok.subarray(1)), 9, DDPI_OPCODE.getProfile), null, "receiver status");

  const corrupt = ok.slice();
  corrupt[20]! ^= 1;
  assert.throws(() => parseDdpiResponse(corrupt, 9, DDPI_OPCODE.getProfile), /CRC/);
  assert.throws(() => parseDdpiResponse(answer(request, profile, 0xa2), 9, DDPI_OPCODE.getProfile), /0xa2/);
  assert.throws(() => parseDdpiResponse(answer(request, profile, 0xa4), 9, DDPI_OPCODE.getProfile), /out of range/);
});

test("capabilities of patch build 21ea252", () => {
  assert.deepEqual(parseDdpiCapabilities(CAPABILITIES_21EA252), {
    flags: 0xfa,
    minDpi: 50,
    maxDpi: 65535,
    minMultiplierQ8_8: 0x10,
    maxMultiplierQ8_8: 0x400,
    sensorDpi: 800,
    clockMs: 120000,
  });
  // Without flag bits 6 and 7 the sensor DPI and clock are not valid.
  const zephyr = CAPABILITIES_21EA252.slice();
  zephyr[7] = 0x32;
  assert.deepEqual([parseDdpiCapabilities(zephyr).sensorDpi, parseDdpiCapabilities(zephyr).clockMs], [null, null]);
  assert.throws(() => parseDdpiCapabilities(new Uint8Array(54)), /capabilities/);
});
