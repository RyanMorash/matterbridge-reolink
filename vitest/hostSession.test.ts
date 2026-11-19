/**
 * @file vitest/hostSession.test.ts
 * @description Tests for one Reolink host session.
 * @author RyanMorash
 */

import { MatterbridgeEndpoint } from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';
import type { ActionContext } from 'matterbridge/matter';
import { PowerSource } from 'matterbridge/matter/clusters';

import type { NormalizedDevice } from '../src/config.js';
import { type HostContext, HostSession } from '../src/hostSession.js';
import type { PushService } from '../src/pushService.js';

interface FakeApi {
  options: object;
  login: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isNvrDevice: ReturnType<typeof vi.fn>;
  getNvrChannelsSummary: ReturnType<typeof vi.fn>;
  getInfo: ReturnType<typeof vi.fn>;
  getDeviceCapabilities: ReturnType<typeof vi.fn>;
  getMotionState: ReturnType<typeof vi.fn>;
  getAiCfg: ReturnType<typeof vi.fn>;
  getBatteryInfo: ReturnType<typeof vi.fn>;
  getWhiteLedState: ReturnType<typeof vi.fn>;
  getSiren: ReturnType<typeof vi.fn>;
  onSimpleEvent: ReturnType<typeof vi.fn>;
  offSimpleEvent: ReturnType<typeof vi.fn>;
  setWhiteLedState: ReturnType<typeof vi.fn>;
  setSiren: ReturnType<typeof vi.fn>;
  ptz: ReturnType<typeof vi.fn>;
  moveToPtzPreset: ReturnType<typeof vi.fn>;
  probeFloodlightSupportByCmd289: ReturnType<typeof vi.fn>;
  subscribeEmailPushEvents: ReturnType<typeof vi.fn>;
  subscribeBaichuanWebhookEvents: ReturnType<typeof vi.fn>;
  setupEmailPushToManager: ReturnType<typeof vi.fn>;
  setupBaichuanWebhookToManager: ReturnType<typeof vi.fn>;
  emit: (event: { type: string; channel: number; timestamp: number; battery?: object }) => void;
}

interface FakeRtsp {
  options: { listenHost?: string; listenPort?: number; profile?: string; path?: string; channel?: number; logger?: { info: (message?: unknown) => void } };
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getRtspUrl: ReturnType<typeof vi.fn>;
  isActive: ReturnType<typeof vi.fn>;
  emit: (event: 'close' | 'error', error?: Error) => void;
}

const harness = vi.hoisted(() => {
  const apis: FakeApi[] = [];
  const servers: FakeRtsp[] = [];
  let rtspBehavior: { failStart?: boolean; failStop?: boolean; closeDuringStart?: boolean; closeDuringStop?: boolean; url?: string } = {};
  class ReolinkBaichuanApi {
    constructor(options: object) {
      const listeners: Array<(event: { type: string; channel: number; timestamp: number; battery?: object }) => void> = [];
      const api = {
        options,
        login: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        isNvrDevice: vi.fn(async () => false),
        getNvrChannelsSummary: vi.fn(async () => ({ channels: [], devices: [] })),
        getInfo: vi.fn(async () => ({ name: 'Porch', serialNumber: 'SER123', type: 'RLC-510A', firmwareVersion: 'v3.1.0.1' })),
        getDeviceCapabilities: vi.fn(async () => ({ capabilities: capabilities() })),
        getMotionState: vi.fn(async () => true),
        getAiCfg: vi.fn(async () => ({ body: { AiCfg: { detectType: 'people,vehicle,dog_cat,package,face' } } })),
        getBatteryInfo: vi.fn(async () => ({ batteryPercent: 55, voltage: 4100, lowPower: 0 })),
        getWhiteLedState: vi.fn(async () => ({ enabled: false })),
        getSiren: vi.fn(async () => ({ enabled: false })),
        onSimpleEvent: vi.fn(async (callback: (event: { type: string; channel: number; timestamp: number }) => void) => {
          listeners.push(callback);
        }),
        offSimpleEvent: vi.fn(async () => {}),
        setWhiteLedState: vi.fn(async () => {}),
        setSiren: vi.fn(async () => {}),
        ptz: vi.fn(async () => {}),
        moveToPtzPreset: vi.fn(async () => {}),
        probeFloodlightSupportByCmd289: vi.fn(async () => true),
        subscribeEmailPushEvents: vi.fn(() => vi.fn()),
        subscribeBaichuanWebhookEvents: vi.fn(() => vi.fn()),
        setupEmailPushToManager: vi.fn(async () => ({})),
        setupBaichuanWebhookToManager: vi.fn(async () => ({})),
        emit: (event: { type: string; channel: number; timestamp: number; battery?: object }): void => {
          for (const listener of listeners) listener(event);
        },
      };
      Object.assign(this, api);
      apis.push(api);
    }

    connected(): boolean {
      return true;
    }
  }
  class BaichuanRtspServer {
    constructor(options: FakeRtsp['options']) {
      const listeners = new Map<string, Array<(error?: Error) => void>>();
      const behavior = rtspBehavior;
      rtspBehavior = {};
      const server: FakeRtsp = {
        options,
        start: vi.fn(async () => {
          if (behavior.closeDuringStart) listeners.get('close')?.forEach((listener) => listener());
          if (behavior.failStart) throw new Error('rtsp down');
        }),
        stop: vi.fn(async () => {
          if (behavior.closeDuringStop) listeners.get('close')?.forEach((listener) => listener());
          if (behavior.failStop) throw new Error('rtsp stop');
        }),
        getRtspUrl: vi.fn(() => behavior.url ?? 'rtsp://127.0.0.1:8554/stream'),
        isActive: vi.fn(() => true),
        emit: (event, error) => {
          listeners.get(event)?.forEach((listener) => listener(error));
        },
      };
      const on = (event: string, listener: (error?: Error) => void): void => {
        const list = listeners.get(event) ?? [];
        list.push(listener);
        listeners.set(event, list);
      };
      Object.assign(this, server, { on, removeAllListeners: (): void => listeners.clear() });
      servers.push(server);
    }

    listening(): boolean {
      return true;
    }
  }
  return {
    apis,
    servers,
    ReolinkBaichuanApi,
    BaichuanRtspServer,
    setRtsp: (behavior: typeof rtspBehavior): void => {
      rtspBehavior = behavior;
    },
  };
});

vi.mock('@apocaliss92/nodelink-js', () => ({
  ReolinkBaichuanApi: harness.ReolinkBaichuanApi,
  BaichuanRtspServer: harness.BaichuanRtspServer,
}));

function capabilities(overrides: Record<string, boolean> = {}): Record<string, boolean | number> {
  return {
    channel: 0,
    hasPan: true,
    hasTilt: true,
    hasZoom: false,
    hasPresets: true,
    hasPtz: true,
    hasBattery: true,
    hasPowerSourceSwitch: false,
    hasBaichuanWebhook: false,
    hasIntercom: false,
    hasSiren: true,
    hasFloodlight: false,
    hasPir: true,
    isDoorbell: false,
    hasAutotracking: false,
    hasWirelessChime: false,
    ...overrides,
  };
}

function device(overrides: Partial<NormalizedDevice> = {}): NormalizedDevice {
  return { host: '10.0.0.8', username: 'admin', password: 'secret', port: 9000, profile: 'sub', ...overrides };
}

function testLog(): AnsiLogger {
  return { fatal: vi.fn(), error: vi.fn(), warn: vi.fn(), notice: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn() } as unknown as AnsiLogger;
}

function context(log: AnsiLogger, overrides: Partial<HostContext> = {}): HostContext & { registered: MatterbridgeEndpoint[] } {
  const registered: MatterbridgeEndpoint[] = [];
  return {
    log,
    reolinkLogger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    vendorId: 0xfff1,
    eventHoldSeconds: 0,
    batteryPollSeconds: 0,
    restartDelayMs: 0,
    configurePush: false,
    emailPort: 2525,
    domain: 'reolink.local',
    validateDevice: () => true,
    setSelectDevice: vi.fn(),
    registerDevice: async (endpoint) => {
      registered.push(endpoint);
    },
    registered,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

const commandContext = { fabric: undefined } as ActionContext;

describe('HostSession', () => {
  beforeEach(() => {
    harness.apis.length = 0;
    harness.servers.length = 0;
    harness.setRtsp({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function create(
    entry: NormalizedDevice = device(),
    overrides: Partial<HostContext> = {},
  ): Promise<{ session: HostSession; api: FakeApi; ctx: ReturnType<typeof context> }> {
    const { ReolinkBaichuanApi } = await import('@apocaliss92/nodelink-js');
    const log = testLog();
    const ctx = context(log, overrides);
    const session = new HostSession(entry, ctx, new ReolinkBaichuanApi({ host: entry.host, username: entry.username, password: entry.password }));
    const api = harness.apis.at(-1);
    if (api === undefined) throw new Error('API was not constructed');
    return { session, api, ctx };
  }

  async function open(entry: NormalizedDevice = device(), overrides: Partial<HostContext> = {}): Promise<{ session: HostSession; api: FakeApi; ctx: ReturnType<typeof context> }> {
    const created = await create(entry, overrides);
    await created.session.start();
    return created;
  }

  it('exposes a camera, forwards PTZ, and scales the battery', async () => {
    const { session, api, ctx } = await open(device({ name: 'Yard', uid: 'UID1', transport: 'tcp' }), { configurePush: true });
    expect(harness.servers[0]?.options).toMatchObject({ listenHost: '127.0.0.1', profile: 'sub', path: '/stream', channel: 0 });
    expect(ctx.registered.map((endpoint) => endpoint.deviceName)).toEqual(
      expect.arrayContaining(['Yard', 'Yard motion', 'Yard person', 'Yard vehicle', 'Yard pet', 'Yard package', 'Yard siren']),
    );
    const camera = ctx.registered[0];
    expect(harness.servers[0]?.getRtspUrl).toHaveBeenCalled();
    expect(camera?.softwareVersion).toBe(3101);
    await session.refreshBatteries();
    expect(api.getBatteryInfo).toHaveBeenCalled();

    camera?.emitCommand('cameraAvSettingsUserLevelManagement', 'mptzSetPosition', { pan: 10, tilt: 5, zoom: 2 }, commandContext);
    await flush();
    expect(api.ptz).toHaveBeenCalled();
    camera?.emitCommand('cameraAvSettingsUserLevelManagement', 'mptzRelativeMove', { panDelta: 5 }, commandContext);
    camera?.emitCommand('cameraAvSettingsUserLevelManagement', 'mptzRelativeMove', { tiltDelta: 1, zoomDelta: 0.2 }, commandContext);
    camera?.emitCommand('cameraAvSettingsUserLevelManagement', 'mptzMoveToPreset', { presetId: 2 }, commandContext);
    camera?.emitCommand('cameraAvSettingsUserLevelManagement', 'mptzMoveToPreset', {}, commandContext);
    camera?.emitCommand('cameraAvSettingsUserLevelManagement', 'mptzSetPosition', null, commandContext);
    await flush();
    expect(api.moveToPtzPreset).toHaveBeenCalledWith(2, 0);

    api.ptz.mockRejectedValueOnce(new Error('ptz blocked'));
    camera?.emitCommand('cameraAvSettingsUserLevelManagement', 'mptzSetPosition', { pan: Number.NaN, tilt: 'up', zoom: 1 }, commandContext);
    camera?.emitCommand('cameraAvSettingsUserLevelManagement', 'mptzSetPosition', { pan: 1000 }, commandContext);
    await flush();
    expect(ctx.log.error).toHaveBeenCalledWith('PTZ failed for 10.0.0.8: ptz blocked');

    const siren = ctx.registered.find((endpoint) => endpoint.id.endsWith('-siren'));
    siren?.eventsOf('onOff').onOff$Changed?.emit(true, false, commandContext);
    siren?.eventsOf('onOff').onOff$Changed?.emit('no', false, commandContext);
    await flush();
    expect(api.setSiren).toHaveBeenCalledWith(true, undefined, 0);

    api.emit({ type: 'battery', channel: 0, timestamp: 1, battery: { batteryPercent: 80 } });
    api.emit({ type: 'battery', channel: 0, timestamp: 1 });
    api.emit({ type: 'face', channel: 0, timestamp: 1 });
    api.emit({ type: 'motion', channel: 9, timestamp: 1 });
    api.emit({ type: 'offline', channel: 0, timestamp: 1 });
    await flush();
    expect(ctx.log.debug).toHaveBeenCalledWith('Yard reported offline');
    await session.shutdown();
    expect(api.offSimpleEvent).toHaveBeenCalled();
    expect(api.close).toHaveBeenCalled();
  });

  it('restarts a closed proxy after the configured delay', async () => {
    const created = await open(device({ name: 'Gate' }), { restartDelayMs: 250, batteryPollSeconds: 0 });
    vi.useFakeTimers();
    try {
      harness.servers[0]?.emit('close');
      expect(harness.servers).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(harness.servers).toHaveLength(2);
      await created.session.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts a closed proxy and keeps the listen port', async () => {
    const { api, ctx } = await open();
    harness.servers[0]?.isActive.mockReturnValue(false);
    harness.servers[0]?.emit('close');
    api.emit({ type: 'online', channel: 0, timestamp: 1 });
    await flush();
    expect(harness.servers).toHaveLength(2);
    expect(harness.servers[1]?.options.listenPort).toBe(8554);
    harness.servers[1]?.emit('error', new Error('reset'));
    harness.servers[1]?.emit('close');
    await flush();
    expect(ctx.log.warn).toHaveBeenCalledWith('RTSP proxy error for 10.0.0.8 channel 0: reset');
    expect(harness.servers.length).toBeGreaterThan(2);
  });

  it('does not restart an active stream and ignores a close after shutdown starts', async () => {
    const { session, api } = await open();
    api.emit({ type: 'online', channel: 0, timestamp: 1 });
    await flush();
    expect(harness.servers).toHaveLength(1);
    harness.servers[0]?.emit('close');
    api.offSimpleEvent.mockImplementation(() => {
      harness.servers[0]?.emit('close');
    });
    await session.shutdown();
    expect(harness.servers).toHaveLength(1);
    expect(api.close).toHaveBeenCalled();
    await session.refreshBatteries();
  });

  it('registers a camera when the proxy fails and logs a failed restart', async () => {
    const { session, ctx } = await open();
    expect(ctx.registered.length).toBeGreaterThan(0);
    const server = harness.servers[0];
    server?.stop.mockRejectedValue(new Error('rtsp stop'));
    harness.setRtsp({ failStart: true });
    server?.emit('close');
    await flush();
    expect(ctx.log.warn).toHaveBeenCalledWith('RTSP proxy stop failed for 10.0.0.8 channel 0: rtsp stop');
    expect(ctx.log.warn).toHaveBeenCalledWith('RTSP proxy did not restart for 10.0.0.8 channel 0');
    await session.shutdown();
  });

  it('ignores a close that arrives before the channel is stored and while stopping', async () => {
    harness.setRtsp({ closeDuringStart: true, closeDuringStop: true, url: 'not a url' });
    const { session, ctx } = await open();
    expect(ctx.registered.length).toBeGreaterThan(0);
    await session.shutdown();
  });

  it('uses a floodlight child and still sends the white LED command', async () => {
    const created = await create(device({ name: 'Lamp' }));
    created.api.getDeviceCapabilities.mockResolvedValue({ capabilities: capabilities({ hasPtz: false, hasFloodlight: true, hasBattery: false, hasSiren: false, hasPir: false }) });
    created.api.getMotionState.mockResolvedValue(false);
    created.api.getAiCfg.mockResolvedValue({ body: {} });
    created.api.probeFloodlightSupportByCmd289.mockResolvedValue(false);
    await created.session.start();
    const { api, ctx } = created;
    const light = ctx.registered[0]?.getChildEndpointById('Light');
    light?.eventsOf('onOff').onOff$Changed?.emit('no', false, commandContext);
    light?.eventsOf('onOff').onOff$Changed?.emit(true, false, commandContext);
    await flush();
    expect(api.setWhiteLedState).toHaveBeenCalledWith(true, undefined, 0);
    api.probeFloodlightSupportByCmd289.mockRejectedValueOnce(new Error('probe'));
    api.setWhiteLedState.mockRejectedValueOnce(new Error('led'));
    light?.eventsOf('onOff').onOff$Changed?.emit(false, true, commandContext);
    await flush();
    expect(ctx.log.error).toHaveBeenCalledWith('Light command failed for 10.0.0.8 channel 0: led');
    await created.session.refreshBatteries();
  });

  it('rings a doorbell without creating occupancy and adds a spotlight', async () => {
    const trigger = vi.spyOn(MatterbridgeEndpoint.prototype, 'triggerSwitchEvent').mockResolvedValue(true);
    const created = await create(device({ name: 'Door' }));
    created.api.getDeviceCapabilities.mockResolvedValue({ capabilities: capabilities({ isDoorbell: true, hasFloodlight: true, hasPtz: false, hasSiren: true }) });
    created.api.getWhiteLedState.mockResolvedValue({ enabled: true });
    created.api.getSiren.mockResolvedValue({ enabled: true });
    created.api.getInfo.mockResolvedValue({ firmwareVersion: '', serialNumber: 'DOORBELL', type: 'DB' });
    await created.session.start();
    const { session, api, ctx } = created;
    expect(ctx.registered.some((endpoint) => endpoint.id.endsWith('-light'))).toBe(true);
    expect(ctx.registered[0]?.softwareVersionString).toBe('1.0.0');
    api.emit({ type: 'doorbell', channel: 0, timestamp: 1 });
    await flush();
    expect(trigger).toHaveBeenCalledWith('Single', ctx.log);
    trigger.mockResolvedValueOnce(false);
    api.emit({ type: 'doorbell', channel: 0, timestamp: 2 });
    await flush();
    expect(ctx.log.warn).toHaveBeenCalledWith('Doorbell press was not delivered for Door');
    trigger.mockRejectedValueOnce(new Error('switch'));
    api.emit({ type: 'doorbell', channel: 0, timestamp: 3 });
    await flush();
    expect(ctx.log.error).toHaveBeenCalledWith('Event handling failed for 10.0.0.8: switch');
    api.setSiren.mockRejectedValueOnce(new Error('siren'));
    ctx.registered
      .find((endpoint) => endpoint.id.endsWith('-siren'))
      ?.eventsOf('onOff')
      .onOff$Changed?.emit(false, true, commandContext);
    await flush();
    expect(ctx.log.error).toHaveBeenCalledWith('Siren command failed for 10.0.0.8 channel 0: siren');
    await session.shutdown();
    trigger.mockRestore();
  });

  it('clears occupancy after the hold and skips a sensor the channel does not have', async () => {
    const created = await create(device(), { eventHoldSeconds: 0 });
    created.api.getAiCfg.mockResolvedValue({ body: { AiCfg: { detectType: 'people' } } });
    await created.session.start();
    created.api.emit({ type: 'vehicle', channel: 0, timestamp: 1 });
    created.api.emit({ type: 'motion', channel: 0, timestamp: 1 });
    created.api.emit({ type: 'people', channel: 0, timestamp: 1 });
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(created.ctx.log.warn).not.toHaveBeenCalledWith(expect.stringContaining('Failed to set occupancy'));
  });

  it('skips offline NVR channels unless they are requested', async () => {
    const discovered = await create(device({ name: 'Hub' }));
    discovered.api.isNvrDevice.mockResolvedValue(true);
    discovered.api.getNvrChannelsSummary.mockResolvedValue({
      channels: [0, 1],
      devices: [
        { channel: -1, name: 'Bad' },
        { channel: 1.5, name: 'Fraction' },
        { channel: 0, online: true, name: 'Sleeping', model: 'M' },
        { channel: 1, online: true, name: 'Driveway', serialNumber: 'CH1', model: 'X' },
        { channel: 2, name: 'Bare' },
        { channel: 3 },
      ],
    });
    await discovered.session.start();
    expect(discovered.ctx.registered.map((endpoint) => endpoint.deviceName)).toContain('Hub Driveway');
    await discovered.session.shutdown();

    const explicit = await create(device({ channels: [0] }));
    explicit.api.isNvrDevice.mockResolvedValue(true);
    explicit.api.getNvrChannelsSummary.mockResolvedValue({ channels: [0], devices: [{ channel: 0, online: false, name: 'Sleeping' }] });
    await explicit.session.start();
    expect(explicit.ctx.registered[0]?.deviceName).toContain('Sleeping');
    await explicit.session.shutdown();
  });

  it('ignores a doorbell event when the doorbell child is missing', async () => {
    const child = vi.spyOn(MatterbridgeEndpoint.prototype, 'getChildEndpointById').mockImplementation((): undefined => {
      return;
    });
    const created = await create();
    created.api.getDeviceCapabilities.mockResolvedValue({
      capabilities: capabilities({ isDoorbell: true, hasFloodlight: false, hasSiren: false, hasPtz: false, hasBattery: false }),
    });
    await created.session.start();
    created.api.emit({ type: 'doorbell', channel: 0, timestamp: 1 });
    await flush();
    expect(created.ctx.log.warn).not.toHaveBeenCalledWith(expect.stringContaining('Doorbell press'));
    child.mockRestore();
    await created.session.shutdown();
  });

  it('does not open RTSP for a device blocked by the whitelist', async () => {
    const { ctx } = await open(device(), { validateDevice: () => false });
    expect(ctx.registered).toEqual([]);
    expect(harness.servers).toEqual([]);
  });

  it('logs a failed login and continues after a close error', async () => {
    const { session, api, ctx } = await open();
    api.login.mockRejectedValueOnce(new Error('denied'));
    api.close.mockRejectedValueOnce(new Error('close'));
    await session.start();
    expect(ctx.log.error).toHaveBeenCalledWith('Login failed for 10.0.0.8: denied');
    expect(ctx.log.warn).toHaveBeenCalledWith('Close failed for 10.0.0.8: close');
  });

  it('skips a channel whose capabilities cannot be read', async () => {
    const created = await create();
    created.api.getDeviceCapabilities.mockRejectedValue(new Error('no caps'));
    await created.session.start();
    expect(created.ctx.registered).toEqual([]);
    expect(created.api.onSimpleEvent).not.toHaveBeenCalled();
    expect(created.ctx.log.error).toHaveBeenCalledWith('Capabilities failed for 10.0.0.8 channel 0: no caps');
    await created.session.shutdown();
    expect(created.api.offSimpleEvent).not.toHaveBeenCalled();
  });

  it('falls back when discovery reads fail', async () => {
    const created = await create();
    created.api.isNvrDevice.mockRejectedValue(new Error('nvr'));
    created.api.getInfo.mockRejectedValue(new Error('info'));
    created.api.getMotionState.mockRejectedValue(new Error('motion'));
    created.api.getAiCfg.mockRejectedValue(new Error('ai'));
    created.api.getDeviceCapabilities.mockResolvedValue({ capabilities: capabilities({ hasPir: false, hasBattery: false, hasSiren: false, hasPtz: false }) });
    created.api.onSimpleEvent.mockRejectedValue(new Error('subscribe'));
    await created.session.start();
    expect(created.ctx.registered.map((endpoint) => endpoint.deviceName)).toEqual(['10.0.0.8 0']);
    expect(created.ctx.log.error).toHaveBeenCalledWith('Event subscription failed for 10.0.0.8: subscribe');
    expect(created.ctx.log.warn).toHaveBeenCalledWith('NVR detection failed for 10.0.0.8: nvr');
  });

  it('uses PIR when motion state fails and keeps a channel when the summary fails', async () => {
    const created = await create();
    created.api.isNvrDevice.mockResolvedValue(true);
    created.api.getNvrChannelsSummary.mockRejectedValue(new Error('summary'));
    created.api.getMotionState.mockRejectedValue(new Error('motion'));
    created.api.getDeviceCapabilities.mockResolvedValue({ capabilities: capabilities({ hasPir: true, hasPtz: false, hasSiren: false, hasBattery: false }) });
    created.api.getAiCfg.mockResolvedValue({ body: { AiCfg: {} } });
    created.api.getInfo.mockResolvedValue({ firmwareVersion: 'v0', name: 'Cam', serialNumber: 'S' });
    await created.session.start();
    expect(created.ctx.registered.some((endpoint) => endpoint.deviceName?.endsWith('motion'))).toBe(true);
    expect(created.ctx.registered[0]?.softwareVersion).toBe(1);
    expect(created.ctx.log.warn).toHaveBeenCalledWith('Channel summary failed for 10.0.0.8: summary');
  });

  it('polls the battery and logs a failed read or write', async () => {
    vi.useFakeTimers();
    const update = vi.spyOn(MatterbridgeEndpoint.prototype, 'updateAttribute');
    try {
      const created = await create(device(), { batteryPollSeconds: 1 });
      created.api.getBatteryInfo
        .mockResolvedValueOnce({ batteryPercent: 55, lowPower: 0, voltage: 4100 })
        .mockResolvedValueOnce({ batteryPercent: 15, lowPower: 0, voltage: 3900 })
        .mockResolvedValueOnce({ batteryPercent: 50, lowPower: 1, voltage: Number.NaN })
        .mockRejectedValueOnce(new Error('battery'))
        .mockResolvedValue({ batteryPercent: 40, lowPower: 0, voltage: 4000 });
      await created.session.start();
      const { session, ctx } = created;
      expect(update).toHaveBeenCalledWith('PowerSource', 'batPercentRemaining', 110, ctx.log);
      expect(update).toHaveBeenCalledWith('PowerSource', 'batVoltage', 4100, ctx.log);
      await vi.advanceTimersByTimeAsync(1000);
      expect(update).toHaveBeenCalledWith('PowerSource', 'batChargeLevel', PowerSource.BatChargeLevel.Warning, ctx.log);
      await vi.advanceTimersByTimeAsync(1000);
      expect(update).toHaveBeenCalledWith('PowerSource', 'batChargeLevel', PowerSource.BatChargeLevel.Critical, ctx.log);
      await vi.advanceTimersByTimeAsync(1000);
      expect(ctx.log.debug).toHaveBeenCalledWith('Battery read failed for 10.0.0.8 channel 0: battery');
      update.mockRejectedValueOnce(new Error('attribute'));
      await session.refreshBatteries();
      expect(ctx.log.warn).toHaveBeenCalledWith(expect.stringContaining('Battery update failed'));
      await session.shutdown();
    } finally {
      update.mockRestore();
      vi.useRealTimers();
    }
  });

  it('logs accessory reads that fail and a missing battery percent', async () => {
    const created = await create();
    created.api.getDeviceCapabilities.mockResolvedValue({ capabilities: capabilities({ hasFloodlight: true, hasSiren: true, isDoorbell: false, hasPtz: false }) });
    created.api.getWhiteLedState.mockRejectedValue(new Error('led state'));
    created.api.getSiren.mockRejectedValue(new Error('siren state'));
    created.api.getBatteryInfo.mockResolvedValue({ voltage: 1 });
    await created.session.start();
    const { ctx } = created;
    expect(ctx.log.debug).toHaveBeenCalledWith('Accessory state failed for 10.0.0.8: led state');
    expect(ctx.registered[0]?.getChildEndpointById('Light')).toBeDefined();
  });

  it('arms email and webhook push and writes the camera settings', async () => {
    const emailOff = vi.fn();
    const webhookOff = vi.fn();
    const push = {
      register: vi.fn(),
      emailRunning: true,
      webhookRunning: true,
      webhookUrl: vi.fn(() => 'http://192.168.1.1:9081/webhook/cam'),
    } as unknown as PushService;
    const created = await create(device(), { configurePush: true, push, pushUsername: 'reolink-push', pushPassword: 'pw', ipv4Address: '192.168.1.1' });
    created.api.isNvrDevice.mockResolvedValue(true);
    created.api.getNvrChannelsSummary.mockResolvedValue({
      channels: [0, 1],
      devices: [
        { channel: 0, online: true, name: 'One' },
        { channel: 1, online: true, name: 'Two' },
      ],
    });
    created.api.subscribeEmailPushEvents.mockReturnValue(emailOff);
    created.api.subscribeBaichuanWebhookEvents.mockReturnValue(webhookOff);
    await created.session.start();
    const { session, api } = created;
    expect(push.register).toHaveBeenCalledTimes(2);
    expect(api.setupEmailPushToManager).toHaveBeenCalledWith(expect.objectContaining({ managerHost: '192.168.1.1', recipientLocalPart: expect.stringContaining('cam-') }), 0);
    expect(api.setupBaichuanWebhookToManager).toHaveBeenCalledWith({ url: 'http://192.168.1.1:9081/webhook/cam' });
    await session.shutdown();
    expect(emailOff).toHaveBeenCalled();
    expect(webhookOff).toHaveBeenCalled();
  });

  it('warns once when push configuration has no bridge address', async () => {
    const push = { register: vi.fn(), emailRunning: false, webhookRunning: true, webhookUrl: vi.fn() } as unknown as PushService;
    const created = await create(device(), { configurePush: true, push });
    created.api.isNvrDevice.mockResolvedValue(true);
    created.api.getNvrChannelsSummary.mockResolvedValue({
      channels: [0, 1],
      devices: [
        { channel: 0, online: true, name: 'One' },
        { channel: 1, online: true, name: 'Two' },
      ],
    });
    await created.session.start();
    const { ctx } = created;
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn).toHaveBeenCalledWith('Push configuration skipped for 10.0.0.8: the bridge IPv4 address is unknown');
  });

  it('logs push setup failures and skips email setup without credentials', async () => {
    const push = { register: vi.fn(), emailRunning: true, webhookRunning: false, webhookUrl: vi.fn() } as unknown as PushService;
    const withoutPassword = await create(device(), { configurePush: true, push, ipv4Address: '192.168.1.1' });
    await withoutPassword.session.start();
    expect(withoutPassword.api.setupEmailPushToManager).not.toHaveBeenCalled();
    await withoutPassword.session.shutdown();
    const failing = await create(device(), { configurePush: true, push, pushUsername: 'user', pushPassword: 'pw', ipv4Address: '192.168.1.1' });
    failing.api.setupEmailPushToManager.mockRejectedValue(new Error('smtp'));
    await failing.session.start();
    const { ctx } = failing;
    await flush();
    expect(ctx.log.error).toHaveBeenCalledWith('Push configuration failed for 10.0.0.8 channel 0: smtp');
  });

  it('logs an event unsubscribe failure', async () => {
    const { session, api, ctx } = await open();
    api.offSimpleEvent.mockRejectedValueOnce(new Error('unsubscribe'));
    await session.shutdown();
    expect(ctx.log.warn).toHaveBeenCalledWith('Event unsubscribe failed for 10.0.0.8: unsubscribe');
  });

  it('logs a long product name from a summary model', async () => {
    const created = await create(device({ channels: [2] }));
    created.api.getInfo.mockResolvedValue({ firmwareVersion: 'v3.0.0.1', type: 'T'.repeat(80) });
    created.api.getNvrChannelsSummary.mockResolvedValue({ channels: [2], devices: [{ channel: 2, name: 'Gate', model: 'M'.repeat(80), serialNumber: 'GATE' }] });
    await created.session.start();
    expect(created.ctx.registered[0]?.productName).toHaveLength(64);
  });
});
