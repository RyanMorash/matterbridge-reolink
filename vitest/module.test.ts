/**
 * @file vitest/module.test.ts
 * @description Tests for the Reolink Matterbridge platform.
 * @author RyanMorash
 */

import path from 'node:path';

import type { MatterbridgeEndpoint, PlatformMatterbridge } from 'matterbridge';
import { type AnsiLogger, LogLevel } from 'matterbridge/logger';
import { VendorId } from 'matterbridge/matter';

import initializePlugin, { ReolinkPlatform, type ReolinkPlatformConfig } from '../src/module.js';

interface FakeApi {
  options: { host?: string; uid?: string; transport?: string; password?: string; logger?: { debug: (message?: unknown) => void } };
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
}

const harness = vi.hoisted(() => {
  const apis: FakeApi[] = [];
  const rtsp: Array<{ options: { listenHost?: string; profile?: string } }> = [];
  const email: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
  const webhook: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; getCameraWebhookPath: (id: string) => string }> = [];
  const credentials = { fail: false, created: true };
  const loginErrors: Error[] = [];
  const bindErrors = { email: '', webhook: '' };
  return { apis, rtsp, email, webhook, credentials, loginErrors, bindErrors };
});

vi.mock('@apocaliss92/nodelink-js', () => ({
  ReolinkBaichuanApi: class {
    constructor(options: FakeApi['options']) {
      const api: FakeApi = {
        options,
        login: vi.fn(async () => {
          const error = harness.loginErrors.shift();
          if (error !== undefined) throw error;
        }),
        close: vi.fn(async () => {}),
        isNvrDevice: vi.fn(async () => false),
        getNvrChannelsSummary: vi.fn(async () => ({ channels: [], devices: [] })),
        getInfo: vi.fn(async () => ({ name: 'Porch', serialNumber: 'SER123', type: 'RLC', firmwareVersion: 'v1.2.3' })),
        getDeviceCapabilities: vi.fn(async () => ({
          capabilities: { hasPtz: false, hasBattery: false, hasSiren: false, hasFloodlight: false, hasPir: false, isDoorbell: false },
        })),
        getMotionState: vi.fn(async () => false),
        getAiCfg: vi.fn(async () => ({ body: {} })),
        getBatteryInfo: vi.fn(async () => ({ batteryPercent: 50 })),
        getWhiteLedState: vi.fn(async () => ({ enabled: false })),
        getSiren: vi.fn(async () => ({ enabled: false })),
        onSimpleEvent: vi.fn(async () => {}),
        offSimpleEvent: vi.fn(async () => {}),
        setWhiteLedState: vi.fn(async () => {}),
        setSiren: vi.fn(async () => {}),
        ptz: vi.fn(async () => {}),
        moveToPtzPreset: vi.fn(async () => {}),
        probeFloodlightSupportByCmd289: vi.fn(async () => false),
        subscribeEmailPushEvents: vi.fn(() => vi.fn()),
        subscribeBaichuanWebhookEvents: vi.fn(() => vi.fn()),
        setupEmailPushToManager: vi.fn(async () => ({})),
        setupBaichuanWebhookToManager: vi.fn(async () => ({})),
      };
      Object.assign(this, api);
      harness.apis.push(api);
    }

    connected(): boolean {
      return true;
    }
  },
  BaichuanRtspServer: class {
    constructor(options: { listenHost?: string; profile?: string; logger?: { debug: (message?: unknown) => void } }) {
      options.logger?.debug?.('rtsp');
      harness.rtsp.push({ options });
    }
    on(): void {}
    removeAllListeners(): void {}
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    getRtspUrl(): string {
      return 'rtsp://127.0.0.1:8554/stream';
    }
    isActive(): boolean {
      return true;
    }
  },
  createEmailPushServer: (): { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } => {
    const server = {
      start: vi.fn(async () => {
        if (harness.bindErrors.email !== '') throw new Error(harness.bindErrors.email);
      }),
      stop: vi.fn(async () => {}),
    };
    harness.email.push(server);
    return server;
  },
  createBaichuanWebhookServer: (): { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; getCameraWebhookPath: (id: string) => string } => {
    const server = {
      start: vi.fn(async () => {
        if (harness.bindErrors.webhook !== '') throw new Error(harness.bindErrors.webhook);
      }),
      stop: vi.fn(async () => {}),
      getCameraWebhookPath: (id: string): string => `/webhook/${id}`,
    };
    harness.webhook.push(server);
    return server;
  },
}));

vi.mock('../src/pushCredentials.js', () => ({
  loadOrCreatePushCredentials: vi.fn(async (filePath: string) => {
    if (harness.credentials.fail) throw new Error(`cannot write ${filePath}`);
    return { username: 'reolink-push', password: 'generated-secret', created: harness.credentials.created };
  }),
}));

function matterbridge(directory: string, ipv4Address: string | undefined, version = '3.11.0'): PlatformMatterbridge {
  return {
    systemInformation: {
      interfaceName: 'eth0',
      macAddress: 'aa:bb:cc:dd:ee:ff',
      ipv4Address,
      ipv6Address: undefined,
      osRelease: 'x.y.z',
      nodeVersion: '22.13.0',
      hostname: 'matterbridge',
      user: 'jest',
      osType: 'Linux',
      osPlatform: 'linux',
      osArch: 'x64',
      totalMemory: '0 B',
      freeMemory: '0 B',
      constrainedMemory: '0 B',
      systemUptime: '0s',
      processUptime: '0s',
      cpuUsage: '0%',
      processCpuUsage: '0%',
      rss: '0 B',
      heapTotal: '0 B',
      heapUsed: '0 B',
    },
    uuid: '00000000-0000-0000-0000-000000000000',
    rootDirectory: directory,
    homeDirectory: directory,
    matterbridgeDirectory: directory,
    matterbridgePluginDirectory: path.join(directory, 'Matterbridge'),
    matterbridgeCertDirectory: path.join(directory, '.mattercert'),
    globalModulesDirectory: path.join(directory, 'node_modules'),
    matterbridgeVersion: version,
    matterbridgeLatestVersion: '3.11.0',
    matterbridgeDevVersion: '3.11.0',
    frontendVersion: '3.0.0',
    bridgeMode: 'bridge',
    restartMode: 'docker',
    virtualMode: 'mounted_switch',
    aggregatorVendorId: VendorId(0xfff1),
    aggregatorVendorName: 'Matterbridge',
    aggregatorProductId: 0x8000,
    aggregatorProductName: 'Matterbridge Vitest Aggregator',
  } as unknown as PlatformMatterbridge;
}

function pluginConfig(overrides: Record<string, unknown> = {}): ReolinkPlatformConfig {
  return {
    name: 'matterbridge-reolink',
    type: 'DynamicPlatform',
    version: '1.0.0',
    debug: false,
    unregisterOnShutdown: false,
    devices: [],
    ...overrides,
  };
}

const logCalls = {
  fatal: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  notice: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
};
const mockLog = logCalls as unknown as AnsiLogger;

const addBridgedEndpoint = vi.fn(async (_pluginName: string, _device: MatterbridgeEndpoint) => {});
const removeBridgedEndpoint = vi.fn(async () => {});
const removeAllBridgedEndpoints = vi.fn(async () => {});
const registerVirtualDevice = vi.fn(async () => {});

describe('Reolink platform', () => {
  let directory = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    harness.apis.length = 0;
    harness.rtsp.length = 0;
    harness.email.length = 0;
    harness.webhook.length = 0;
    harness.credentials.fail = false;
    harness.credentials.created = true;
    harness.loginErrors.length = 0;
    harness.bindErrors.email = '';
    harness.bindErrors.webhook = '';
    directory += 1;
  });

  function platform(config: ReolinkPlatformConfig, version = '3.11.0', ipv4: string | null = '192.168.1.1'): ReolinkPlatform {
    const host = matterbridge(path.join('.cache', 'vitest', `reolink-${directory}`), ipv4 ?? undefined, version);
    const instance = new ReolinkPlatform(host, mockLog, config);
    const node = instance as unknown as {
      setMatterNode: (
        add: typeof addBridgedEndpoint,
        remove: typeof removeBridgedEndpoint,
        removeAll: typeof removeAllBridgedEndpoints,
        register: typeof registerVirtualDevice,
      ) => void;
    };
    node.setMatterNode(addBridgedEndpoint, removeBridgedEndpoint, removeAllBridgedEndpoints, registerVirtualDevice);
    return instance;
  }

  it('rejects an old Matterbridge version', () => {
    expect(() => platform(pluginConfig(), '2.0.0')).toThrow(
      'This plugin requires Matterbridge version >= "3.11.0". Please update Matterbridge from 2.0.0 to the latest version in the frontend.',
    );
  });

  it('starts with no devices and reports the reason', async () => {
    const instance = platform(pluginConfig());
    const exported = initializePlugin(matterbridge(path.join('.cache', 'vitest', `reolink-init-${directory}`), '192.168.1.1'), mockLog, pluginConfig());
    expect(exported).toBeInstanceOf(ReolinkPlatform);
    await exported.onShutdown();
    await instance.onStart('Vitest');
    await instance.onStart();
    expect(mockLog.info).toHaveBeenCalledWith('Starting platform matterbridge-reolink with reason: Vitest...');
    expect(mockLog.info).toHaveBeenCalledWith('Starting platform matterbridge-reolink with reason: no reason provided...');
    expect(addBridgedEndpoint).not.toHaveBeenCalled();
    await instance.onConfigure();
    await instance.onChangeLoggerLevel(LogLevel.DEBUG);
    expect(mockLog.info).toHaveBeenCalledWith('onChangeLoggerLevel called with: debug');
    await instance.onShutdown('Vitest');
    expect(removeAllBridgedEndpoints).not.toHaveBeenCalled();
    instance.config.unregisterOnShutdown = true;
    await instance.onShutdown();
    expect(removeAllBridgedEndpoints).toHaveBeenCalled();
  });

  it('skips invalid and duplicate hosts and a failed login', async () => {
    const instance = platform(
      pluginConfig({
        devices: [
          { host: '10.0.0.2', username: 'admin', password: 'secret', uid: 'UID', transport: 'udp' },
          { host: '10.0.0.2', username: 'admin', password: 'secret', port: 9000 },
          { host: '10.0.0.3', username: 'admin', password: 'secret' },
          { username: 'admin' },
        ],
        configurePush: true,
        push: 'none',
      }),
    );
    harness.loginErrors.push(new Error('denied'));
    await instance.onStart('Vitest');
    const first = harness.apis[0];
    expect(mockLog.warn).toHaveBeenCalledWith('Skipped duplicate host 10.0.0.2');
    expect(mockLog.warn).toHaveBeenCalledWith('configurePush is enabled but push is none, so camera push settings were not changed');
    expect(mockLog.error).toHaveBeenCalledWith('Login failed for 10.0.0.2: denied');
    expect(first?.options).toMatchObject({ uid: 'UID', transport: 'udp' });
    expect(JSON.stringify(logCalls.info.mock.calls)).not.toContain('secret');
    expect(addBridgedEndpoint).toHaveBeenCalled();
    await instance.onConfigure();
    expect(harness.rtsp[0]?.options.listenHost).toBe('127.0.0.1');
    first?.options.logger?.debug?.({ password: 'secret' });
    await instance.onShutdown();
  });

  it('does not register a device outside the whitelist', async () => {
    const instance = platform(pluginConfig({ whiteList: ['Other'], devices: [{ host: '10.0.0.4', username: 'admin', password: 'secret' }] }));
    await instance.onStart();
    expect(addBridgedEndpoint).not.toHaveBeenCalled();
    expect(harness.rtsp).toEqual([]);
    await instance.onShutdown();
  });

  it('starts email and webhook push and writes them to the camera', async () => {
    const instance = platform(
      pluginConfig({
        push: 'both',
        configurePush: true,
        devices: [{ host: '10.0.0.5', username: 'admin', password: 'secret' }],
      }),
    );
    await instance.onStart();
    expect(harness.email).toHaveLength(1);
    expect(harness.webhook).toHaveLength(1);
    expect(mockLog.info).toHaveBeenCalledWith(expect.stringContaining('Created email push credentials'));
    expect(harness.apis[0]?.setupEmailPushToManager).toHaveBeenCalledWith(expect.objectContaining({ managerHost: '192.168.1.1', authPassword: 'generated-secret' }), 0);
    expect(harness.apis[0]?.setupBaichuanWebhookToManager).toHaveBeenCalledWith({ url: expect.stringContaining('http://192.168.1.1:') });
    expect(JSON.stringify(logCalls.info.mock.calls)).not.toContain('generated-secret');
    harness.email[0]?.stop.mockRejectedValueOnce(new Error('stop'));
    await instance.onShutdown();
    expect(mockLog.warn).toHaveBeenCalledWith('Email push failed to stop: stop');
  });

  it('does not announce email credentials that already exist', async () => {
    harness.credentials.created = false;
    const instance = platform(pluginConfig({ push: 'email', devices: [] }));
    await instance.onStart();
    expect(mockLog.info).not.toHaveBeenCalledWith(expect.stringContaining('Created email push credentials'));
    await instance.onShutdown();
  });

  it('starts webhook push without email credentials', async () => {
    const instance = platform(pluginConfig({ push: 'webhook', devices: [{ host: '10.0.0.6', username: 'admin', password: 'secret' }] }));
    await instance.onStart();
    expect(harness.email).toEqual([]);
    expect(harness.webhook).toHaveLength(1);
    expect(harness.apis[0]?.subscribeBaichuanWebhookEvents).toHaveBeenCalled();
    await instance.onShutdown();
  });

  it('skips email push when credentials cannot be stored and still starts webhook for both', async () => {
    harness.credentials.fail = true;
    const emailOnly = platform(pluginConfig({ push: 'email', devices: [{ host: '10.0.0.7', username: 'admin', password: 'secret' }] }));
    await emailOnly.onStart();
    expect(harness.email).toEqual([]);
    expect(mockLog.error).toHaveBeenCalledWith(expect.stringContaining('Email push credentials failed'));
    await emailOnly.onShutdown();

    const both = platform(pluginConfig({ push: 'both', devices: [{ host: '10.0.0.8', username: 'admin', password: 'secret' }] }));
    await both.onStart();
    expect(harness.webhook.length).toBeGreaterThan(0);
    await both.onShutdown();
  });

  it('logs an email server that fails to bind and a missing IPv4 address', async () => {
    const noAddress = platform(pluginConfig({ push: 'email', configurePush: true, devices: [{ host: '10.0.0.9', username: 'admin', password: 'secret' }] }), '3.11.0', null);
    await noAddress.onStart();
    expect(mockLog.warn).toHaveBeenCalledWith('configurePush was skipped because the bridge IPv4 address is unknown');
    await noAddress.onShutdown();

    harness.bindErrors.email = 'bind';
    const failing = platform(pluginConfig({ push: 'email', devices: [] }));
    await failing.onStart();
    expect(mockLog.error).toHaveBeenCalledWith('Email push failed to start: bind');
    await failing.onShutdown();
  });

  it('logs a webhook server that fails to bind', async () => {
    harness.bindErrors.webhook = 'bind';
    const failing = platform(pluginConfig({ push: 'webhook' }));
    await failing.onStart();
    expect(mockLog.error).toHaveBeenCalledWith('Webhook push failed to start: bind');
    await failing.onShutdown();
  });
});
