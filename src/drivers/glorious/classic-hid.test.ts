import assert from "node:assert/strict";
import test from "node:test";

import { GloriousClassicHidClient } from "./classic-hid.ts";
import { VENDOR_ID } from "../vendors.ts";
import {
  DDPI_FLAG_ENABLED,
  DDPI_OPCODE,
  ddpiCrc16,
  decodeDdpiProfile,
  encodeDdpiProfile,
  type DdpiProfile,
} from "../../open-directional-dpi/index.ts";

function fakeCollection(usagePage: number, usage = 1) {
  return {
    usagePage,
    usage,
    type: 1,
    children: [],
    inputReports: [],
    outputReports: [],
    featureReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
  };
}

/**
 * `reply` returns what successive GET_REPORTs read after a SET_REPORT; the last
 * entry repeats. Without it every read returns 64 zero bytes.
 */
function fakeDevice(vendorId: number, productId: number, productName = "", reply?: (payload: Uint8Array) => Uint8Array[]) {
  const sent: Array<{ reportId: number; payload: Uint8Array }> = [];
  let replies: Uint8Array[] = [new Uint8Array(64)];
  const device = {
    vendorId,
    productId,
    productName,
    opened: true,
    collections: [fakeCollection(0xff01)],
    open: async () => {},
    close: async () => {},
    sendFeatureReport: async (reportId: number, source: BufferSource) => {
      const view = ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        : new Uint8Array(source);
      sent.push({ reportId, payload: new Uint8Array(view) });
      if (reply) replies = reply(new Uint8Array(view));
    },
    receiveFeatureReport: async () => new DataView((replies.length > 1 ? replies.shift()! : replies[0]!).slice().buffer),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { device: device as unknown as HIDDevice, sent };
}

test("recognizes a core1 device (Model O Wireless, VID 0x258a)", () => {
  const { device } = fakeDevice(VENDOR_ID.gloriousClassic, 0x2022);
  assert.equal(GloriousClassicHidClient.isSupported(device), true);
});

test("recognizes a core2 device (Model O3 Wireless, VID 0x3794)", () => {
  const { device } = fakeDevice(VENDOR_ID.gloriousO3, 0xa312);
  assert.equal(GloriousClassicHidClient.isSupported(device), true);
});

test("claims the Model O 2 PRO pair and Series 2 PRO from CORE's device table", () => {
  // 0x2019/0x2033 are the O 2 PRO wired PID + receiver (CORE's SupportDevice.DB
  // pairs them; 0x2033 was previously mislabeled "Model O 2 Wireless").
  assert.equal(GloriousClassicHidClient.isSupported(fakeDevice(VENDOR_ID.gloriousClassic, 0x2019).device), true);
  assert.equal(GloriousClassicHidClient.isSupported(fakeDevice(VENDOR_ID.gloriousClassic, 0x2033).device), true);
  // Series 2 PRO, wired + receiver: classic commands for everything except
  // >1000 Hz polling, which the classic payload cannot express.
  assert.equal(GloriousClassicHidClient.isSupported(fakeDevice(VENDOR_ID.gloriousClassic, 0x201d).device), true);
  assert.equal(GloriousClassicHidClient.isSupported(fakeDevice(VENDOR_ID.gloriousClassic, 0x2039).device), true);
  const series2 = new GloriousClassicHidClient(fakeDevice(VENDOR_ID.gloriousClassic, 0x201d).device);
  assert.deepEqual(series2.getSupportedPollingRates(), [125, 250, 500, 1000]);
});

test("recognizes a Model D Wireless whose config lives on the 0xffff:0 collection", () => {
  // A real 0x258a:0x2012 (Model D Wireless) exposed `usage 0xffff:0 feat[0x0]`
  // as its control interface; the old 0xff01/0xff00-only match rejected it.
  const { device } = fakeDevice(VENDOR_ID.gloriousClassic, 0x2012, "Model D Wireless");
  (device.collections[0] as { usagePage: number }).usagePage = 0xffff;
  (device.collections[0] as { usage: number }).usage = 0;
  assert.equal(GloriousClassicHidClient.isSupported(device), true);
});

test("recognizes a Model O V2 Wired whose config channel is numbered report 7", () => {
  // A real 0x320f:0x823a rejected connection entirely: its `usage 0xff01:1`
  // collection carries feature report id 7, not the unnumbered report (0)
  // every other classic-family device uses.
  const { device } = fakeDevice(VENDOR_ID.gloriousClassicIWired, 0x823a, "Model O 2 Wired Mouse");
  (device.collections[0].featureReports[0] as { reportId: number }).reportId = 7;
  assert.equal(GloriousClassicHidClient.isSupported(device), true);
});

test("a numbered config report is used for every write, not the unnumbered default", async () => {
  const { device, sent } = fakeDevice(VENDOR_ID.gloriousClassicIWired, 0x823a);
  (device.collections[0].featureReports[0] as { reportId: number }).reportId = 7;
  const client = new GloriousClassicHidClient(device);

  await client.setDpi(1600);
  await client.setPollingRate(500);
  await client.setLiftOffDistance("High");

  assert.ok(sent.length >= 3);
  for (const report of sent) assert.equal(report.reportId, 7, "every write should use the discovered report id");
});

test("a report length other than 64 bytes refuses writes instead of guessing at the layout", async () => {
  // The real 0x320f:0x823a unit's numbered report 7 declares a 263-byte
  // length. Resizing the driver's 64-byte payload to fit no longer errors
  // at the WebHID level, but a diagnostic confirmed the mouse silently
  // ignores it - the write ACKs and nothing on the mouse changes. Refuse
  // instead of sending a payload with an unconfirmed byte layout.
  const { device, sent } = fakeDevice(VENDOR_ID.gloriousClassicIWired, 0x823a);
  const report = device.collections[0].featureReports[0] as { reportId: number; items: Array<{ reportSize: number; reportCount: number }> };
  report.reportId = 7;
  report.items = [{ reportSize: 8, reportCount: 263 }];
  const client = new GloriousClassicHidClient(device);

  assert.deepEqual(client.getDpiOptions(), []);
  assert.deepEqual(client.getSupportedPollingRates(), []);
  await assert.rejects(() => client.setDpi(1600), /not confirmed/);
  await assert.rejects(() => client.setPollingRate(500), /not confirmed/);
  await assert.rejects(() => client.setLiftOffDistance("High"), /not confirmed/);
  await assert.rejects(() => client.setDebounceTime(4), /not confirmed/);
  await assert.rejects(() => client.setRgb({ effect: "solid", rate: 0, colors: ["#ff0000"] }), /not confirmed/);
  assert.equal(sent.length, 0, "nothing should be sent once the report length is unconfirmed");

  const status = await client.readStatus();
  assert.equal(status.dpi, 0);
  assert.equal(status.pollingRateHz, 0);
  assert.equal(status.liftOffDistance, null);
});

test("rejects an unrecognized VID/PID pair", () => {
  const { device } = fakeDevice(VENDOR_ID.gloriousO3, 0x1234);
  assert.equal(GloriousClassicHidClient.isSupported(device), false);
});

// The driver caches state in `localStorage` (unavailable under plain node:test),
// so writes silently no-op between calls here — assert on the write itself
// (return value + a feature report actually sent) rather than a later read.
test("core1 device exposes full DPI/polling/LOD support", async () => {
  const { device, sent } = fakeDevice(VENDOR_ID.gloriousClassic, 0x2011); // Model D Wireless
  const client = new GloriousClassicHidClient(device);
  assert.ok(client.getDpiOptions().length > 0);
  assert.ok(client.getSupportedPollingRates().length > 0);
  assert.equal(await client.setDpi(1600), 1600);
  assert.equal(await client.setPollingRate(500), 500);
  assert.equal(await client.setLiftOffDistance("High"), "High");
  assert.ok(sent.length >= 3, "expected DPI/stage, polling, and LOD writes");
  const status = await client.readStatus();
  assert.equal(status.ui?.valuesVerified, false);
  assert.notEqual(status.ui?.settingsReady, false);
  assert.notEqual(status.liftOffDistance, null);
  assert.ok(status.supportedPollingRates && status.supportedPollingRates.length > 0);
});

test("core2 device (Model O3 Wireless) has no DPI/polling/LOD, only RGB/debounce/battery", async () => {
  const { device } = fakeDevice(VENDOR_ID.gloriousO3, 0xa312);
  const client = new GloriousClassicHidClient(device);
  assert.deepEqual(client.getDpiOptions(), []);
  assert.deepEqual(client.getSupportedPollingRates(), []);
  await assert.rejects(() => client.setDpi(1600), /not confirmed/);
  await assert.rejects(() => client.setPollingRate(500), /not confirmed/);
  await assert.rejects(() => client.setLiftOffDistance("High"), /not confirmed/);
  // Still works: debounce and RGB writes go through unconditionally.
  assert.equal(await client.setDebounceTime(4), 4);
  const rgb = await client.setRgb({ effect: "solid", rate: 0, colors: ["#ff0000"] });
  assert.equal(rgb.effect, "solid");
  const status = await client.readStatus();
  assert.equal(status.dpi, 0);
  assert.equal(status.pollingRateHz, 0);
  assert.equal(status.liftOffDistance, null);
  assert.equal(status.ui?.statusNote?.includes("newer protocol generation"), true);
});

test("Model D 2 PRO 4K/8KHz Edition left the classic table for the core2 driver", () => {
  // 0x201c/0x2036 graduated to GLORIOUS_CORE2_PRODUCTS (full DPI/polling/driver
  // support); the classic driver must no longer claim either PID.
  assert.equal(GloriousClassicHidClient.isSupported(fakeDevice(VENDOR_ID.gloriousClassic, 0x201c).device), false);
  assert.equal(GloriousClassicHidClient.isSupported(fakeDevice(VENDOR_ID.gloriousClassic, 0x2036).device), false);
});

// ---------------------------------------------------------------------------
// Open Directional DPI on a Series One Pro (ported from open-directional-dpi's
// integrations/openmouse tests 01-03, 17 and 20).
// ---------------------------------------------------------------------------

const STOCK_VERSION_REPLY = [0xa1, 0x00, 0x00, 0x03, 0x00, 0x81, 0x01, 0x00, 0x00, 0x00, 0x20, 0x18];
const DP01 = [0x44, 0x50, 0x30, 0x31];
// GET_CAPABILITIES payload in the layout of patch build 21ea252: flags 0xfa, 800 DPI.
const CAPABILITIES = Uint8Array.from(Buffer.from("44503031010100fa3200ffff1000000410802003c0d40100", "hex"));
const NEUTRAL: DdpiProfile = { flags: 0, baseDpi: 800, globalGainQ8_8: 256, multipliersQ8_8: [256, 256, 256, 256, 256, 256, 256, 256], reserved: 0 };
const UP_HALF: DdpiProfile = { ...NEUTRAL, flags: DDPI_FLAG_ENABLED, multipliersQ8_8: [256, 256, 256, 256, 256, 256, 128, 256] };

const isDdpi = (packet: Uint8Array) => packet[0] === 0x44 && packet[1] === 0x50;
const status = (byte: number) => Uint8Array.of(byte, ...new Uint8Array(63));

/**
 * A Series One Pro by cable or through its receiver. A patched mouse stamps the
 * version reply and answers requests like patch build 21ea252. `lag` turns the
 * answer and the previous answer into what successive GET_REPORTs return.
 */
function seriesOnePro({ patched, receiver = false }: { patched: boolean; receiver?: boolean }) {
  const mouse = {
    profile: encodeDdpiProfile(NEUTRAL),
    previous: new Uint8Array(64),
    lag: (answer: Uint8Array, _previous: Uint8Array): Uint8Array[] => [answer],
  };
  const answerTo = (request: Uint8Array): Uint8Array => {
    const reply = new Uint8Array(64);
    if (isDdpi(request)) {
      assert.ok(patched, "a stock mouse got an Open Directional DPI packet");
      const packet = request.slice();
      if (receiver) {
        assert.deepEqual([packet[2], packet[3]], [0x02, 0x3a], "relay envelope");
        packet[2] = 0x01;
        packet[3] = 0x00;
      }
      assert.equal(packet[62]! | (packet[63]! << 8), ddpiCrc16(packet.subarray(0, 62)), "CRC over the canonical packet");
      if (packet[6] === DDPI_OPCODE.setProfile) mouse.profile = encodeDdpiProfile(decodeDdpiProfile(packet.subarray(8)));
      reply.set(packet.subarray(0, 8));
      reply[3] = 0xa1;
      reply.set(packet[6] === DDPI_OPCODE.getCapabilities ? CAPABILITIES : mouse.profile, 8);
      const crc = ddpiCrc16(reply.subarray(0, 62));
      reply[62] = crc & 0xff;
      reply[63] = crc >> 8;
      return reply;
    }
    if (receiver) assert.equal(request[2], 0x02, "a request ran a receiver-local handler");
    if (request[4] === 0x00 && request[5] === 0x81) {
      reply.set(STOCK_VERSION_REPLY);
      reply[2] = request[2]!;
      if (patched) {
        reply.set(DP01, 12);
        reply.set(DP01, 16);
      }
      // The receiver copies back as many bytes as the request asked for.
      if (receiver) reply.fill(0, request[3]! + 6);
    }
    return reply;
  };
  const { device, sent } = fakeDevice(VENDOR_ID.gloriousClassic, receiver ? 0x2031 : 0x2018, "Series One PRO Wireless", (request) => {
    const answer = answerTo(request);
    const replies = mouse.lag(answer, mouse.previous);
    mouse.previous = answer;
    return replies;
  });
  (device.collections[0] as { usagePage: number }).usagePage = 0xffff;
  return { client: new GloriousClassicHidClient(device), sent, mouse };
}

test("a stock Series One Pro gets the version query once and never an Open Directional DPI packet", async () => {
  for (const receiver of [false, true]) {
    const { client, sent } = seriesOnePro({ patched: false, receiver });
    assert.equal((await client.readStatus()).directionalDpi, undefined);
    await assert.rejects(() => client.setDirectionalDpiProfile(UP_HALF), /does not have the Open Directional DPI patch/);
    await assert.rejects(() => client.saveDirectionalDpi(), /does not have/);
    assert.equal((await client.readStatus()).directionalDpi, undefined);
    assert.equal(sent.filter(({ payload }) => isDdpi(payload)).length, 0);
    assert.equal(sent.filter(({ payload }) => payload[5] === 0x81).length, 1, "detection is cached");
  }
});

test("other classic mice get no directional DPI request at all", async () => {
  const { device, sent } = fakeDevice(VENDOR_ID.gloriousClassic, 0x2011);
  const client = new GloriousClassicHidClient(device);
  assert.equal((await client.readStatus()).directionalDpi, undefined);
  await assert.rejects(() => client.setDirectionalDpiProfile(UP_HALF), /needs a Series One Pro/);
  assert.equal(sent.filter(({ payload }) => payload[5] === 0x81 || isDdpi(payload)).length, 0);
});

test("a patched Series One Pro by cable reads, sets and saves its profile", async () => {
  const { client, sent } = seriesOnePro({ patched: true });
  assert.deepEqual((await client.readStatus()).directionalDpi, { profile: NEUTRAL, sensorDpi: 800, canSave: true });
  assert.deepEqual(await client.setDirectionalDpiProfile(UP_HALF), UP_HALF);
  assert.deepEqual(await client.saveDirectionalDpi(), UP_HALF);
  const requests = sent.filter(({ payload }) => isDdpi(payload)).map(({ payload }) => [payload[4], payload[6]]);
  assert.deepEqual(requests, [[5, 0x01], [6, 0x02], [7, 0x03], [8, 0x04]]);
  await assert.rejects(() => client.setDirectionalDpiProfile({ ...UP_HALF, baseDpi: 10 }), /Base DPI/);
  assert.equal(sent.filter(({ payload }) => isDdpi(payload)).length, 4, "an invalid profile is not sent");
});

test("through the receiver: envelope, stale answers and a transient 0xa4 before the answer", async () => {
  const { client, sent, mouse } = seriesOnePro({ patched: true, receiver: true });
  // The previous answer, then pending, then the link briefly down (a flash erase).
  mouse.lag = (answer, previous) => [previous, status(0xa0), status(0xa4), status(0xa4), answer];
  assert.deepEqual((await client.readStatus()).directionalDpi, { profile: NEUTRAL, sensorDpi: 800, canSave: true });
  assert.deepEqual(await client.setDirectionalDpiProfile(UP_HALF), UP_HALF);
  // Same opcode again: the previous answer differs only in seq and must be skipped.
  assert.deepEqual(await client.setDirectionalDpiProfile(NEUTRAL), NEUTRAL);
  assert.deepEqual(await client.saveDirectionalDpi(), NEUTRAL);
  assert.equal(sent.filter(({ payload }) => isDdpi(payload)).length, 5);
});

test("through the receiver: a final 0xa4 is an error and detection is asked again later", async () => {
  const { client, sent, mouse } = seriesOnePro({ patched: true, receiver: true });
  mouse.lag = () => [status(0xa4)];
  assert.equal((await client.readStatus()).directionalDpi, undefined);
  await assert.rejects(() => client.setDirectionalDpiProfile(UP_HALF), /receiver cannot reach the mouse/);
  assert.equal(sent.filter(({ payload }) => isDdpi(payload)).length, 0, "no request before the stamp was seen");
  mouse.lag = (answer) => [answer];
  assert.equal((await client.readStatus()).directionalDpi?.canSave, true);
});

test("through the receiver: no directional DPI read while the battery read says the mouse is asleep", async () => {
  // The receiver answers 0xa4 at once when the link is down, over the request it holds.
  const { device, sent } = fakeDevice(VENDOR_ID.gloriousClassic, 0x2031, "", (request) => [Uint8Array.of(0xa4, ...request.subarray(1))]);
  (device.collections[0] as { usagePage: number }).usagePage = 0xffff;
  const client = new GloriousClassicHidClient(device);
  assert.equal((await client.readStatus()).directionalDpi, undefined);
  assert.equal(sent.filter(({ payload }) => payload[5] === 0x81 || isDdpi(payload)).length, 0);
  assert.equal(sent.length, 1, "only the battery request");
});

test("a 65-byte reply with a leading report id is accepted", async () => {
  const { client, mouse } = seriesOnePro({ patched: true });
  mouse.lag = (answer) => [Uint8Array.of(0, ...answer)];
  assert.deepEqual(await client.setDirectionalDpiProfile(UP_HALF), UP_HALF);
});

test("a battery read cannot land between a request and its answer", async () => {
  const { client, sent, mouse } = seriesOnePro({ patched: true, receiver: true });
  await client.readStatus();
  mouse.lag = (answer) => [status(0xa0), status(0xa0), status(0xa0), status(0xa0), answer];
  const setting = client.setDirectionalDpiProfile(UP_HALF);
  // Start the status read (and its battery request) while SET_PROFILE waits for its answer.
  while (!sent.some(({ payload }) => isDdpi(payload) && payload[6] === DDPI_OPCODE.setProfile)) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const reading = client.readStatus();
  assert.deepEqual(await setting, UP_HALF);
  assert.deepEqual((await reading).directionalDpi?.profile, UP_HALF);
});
