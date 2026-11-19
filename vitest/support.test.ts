/**
 * @file vitest/support.test.ts
 * @description Unit tests for config, labels, detection, and push helpers.
 * @author RyanMorash
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MatterbridgeEndpoint, occupancySensor, type PlatformConfig } from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';
import { PowerSource } from 'matterbridge/matter/clusters';

import { readBatteryPercent, toBatChargeLevel, toBatPercentRemaining } from '../src/battery.js';
import { selectChannels } from '../src/channels.js';
import { normalizeConfig, type ReolinkPlatformConfig } from '../src/config.js';
import { actionForEvent, primaryKind, sensorKinds } from '../src/detection.js';
import { channelLabel, endpointId, limitLabel, serialWithSuffix, withSuffix } from '../src/labels.js';
import { createReolinkLogger, errorText } from '../src/logger.js';
import { armOccupancy, clearOccupancyTimers, setOccupancy } from '../src/occupancy.js';
import { clampAxis, movesForTarget, PTZ_HOME } from '../src/ptz.js';
import { loadOrCreatePushCredentials } from '../src/pushCredentials.js';
import { rtspPort } from '../src/rtsp.js';

const log = {
  fatal: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  notice: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
} as unknown as AnsiLogger;

function config(overrides: Record<string, unknown> = {}): ReolinkPlatformConfig {
  return {
    name: 'matterbridge-reolink',
    type: 'DynamicPlatform',
    version: '1.0.0',
    debug: false,
    unregisterOnShutdown: false,
    ...overrides,
  };
}

describe('Reolink support helpers', () => {
  it('normalizes devices and clamps platform settings', () => {
    const normalized = normalizeConfig(
      config({
        devices: [
          { host: ' 10.0.0.2 ', username: 'admin', password: 'secret', name: ' Porch ', port: 9001, uid: ' UID ', transport: 'udp', channels: [1, 1, 2, -1, 1.5], profile: 'main' },
          { host: '10.0.0.3', username: 'admin', password: 'secret' },
          { host: '', username: 'admin', password: 'secret' },
          'camera',
        ],
        eventHoldSeconds: 0,
        batteryPollSeconds: 90000,
        push: 'email',
        configurePush: true,
        emailPushPort: 0,
        webhookPort: 70000,
        emailPushDomain: ' alerts.local ',
      }),
    );
    expect(normalized.devices[0]).toMatchObject({ host: '10.0.0.2', name: 'Porch', port: 9001, uid: 'UID', transport: 'udp', channels: [1, 2], profile: 'main' });
    expect(normalized.devices[1]).toMatchObject({ port: 9000, profile: 'sub' });
    expect(normalized.devices[1]?.uid).toBeUndefined();
    const rejected = normalizeConfig(config({ devices: [{ host: '10.0.0.9', username: 'admin', password: 'secret', channels: [-1, 1.5, 256] }] }));
    expect(rejected.devices[0]?.channels).toBeUndefined();
    expect(normalized.warnings).toEqual(['Skipped device 2: host, username, and password are required', 'Skipped device 3: expected an object']);
    expect(normalized.eventHoldSeconds).toBe(30);
    expect(normalized.batteryPollSeconds).toBe(300);
    expect(normalized.push).toBe('email');
    expect(normalized.configurePush).toBe(true);
    expect(normalized.emailPushPort).toBe(2525);
    expect(normalized.webhookPort).toBe(9081);
    expect(normalized.emailPushDomain).toBe('alerts.local');
  });

  it('ignores a devices field that is not an array and unknown enums', () => {
    const normalized = normalizeConfig(config({ devices: { host: '10.0.0.2' }, push: 'sms', profile: 'high', emailPushDomain: '  ' }));
    expect(normalized.devices).toEqual([]);
    expect(normalized.warnings).toEqual(['Ignored devices: expected an array']);
    expect(normalized.push).toBe('none');
    expect(normalized.emailPushDomain).toBe('reolink.local');
    expect(normalizeConfig(config()).devices).toEqual([]);
  });

  it('drops empty optional device fields', () => {
    const normalized = normalizeConfig(
      config({ devices: [{ host: '10.0.0.4', username: 'admin', password: 'secret', uid: ' ', transport: 'auto', channels: [], profile: 'nope', name: ' ' }] }),
    );
    expect(normalized.devices[0]).toEqual({ host: '10.0.0.4', username: 'admin', password: 'secret', port: 9000, profile: 'sub' });
  });

  it('maps battery percent to Matter power source values', () => {
    expect(readBatteryPercent(null)).toBeUndefined();
    expect(readBatteryPercent({ voltage: 1 })).toBeUndefined();
    expect(readBatteryPercent({ batteryPercent: 101 })).toBeUndefined();
    expect(readBatteryPercent({ batteryPercent: 55 })).toBe(55);
    expect(toBatPercentRemaining(55)).toBe(110);
    expect(toBatPercentRemaining(-4)).toBe(0);
    expect(toBatPercentRemaining(150)).toBe(200);
    expect(toBatChargeLevel(55)).toBe(PowerSource.BatChargeLevel.Ok);
    expect(toBatChargeLevel(20)).toBe(PowerSource.BatChargeLevel.Warning);
    expect(toBatChargeLevel(10)).toBe(PowerSource.BatChargeLevel.Critical);
    expect(toBatChargeLevel(80, 1)).toBe(PowerSource.BatChargeLevel.Critical);
  });

  it('selects doorbells, floodlights, cameras, and real sensors', () => {
    expect(primaryKind(true, true)).toBe('doorbell');
    expect(primaryKind(false, true)).toBe('floodlight');
    expect(primaryKind(false, false)).toBe('camera');
    expect(sensorKinds(false)).toEqual([]);
    expect(sensorKinds(true, 'people, person, vehicle, dog_cat, pet, animal, package, face, unknown')).toEqual(['motion', 'person', 'vehicle', 'pet', 'package']);
    expect(actionForEvent('motion')).toEqual({ type: 'occupancy', sensor: 'motion' });
    expect(actionForEvent('people')).toEqual({ type: 'occupancy', sensor: 'person' });
    expect(actionForEvent('vehicle')).toEqual({ type: 'occupancy', sensor: 'vehicle' });
    expect(actionForEvent('animal')).toEqual({ type: 'occupancy', sensor: 'pet' });
    expect(actionForEvent('package')).toEqual({ type: 'occupancy', sensor: 'package' });
    expect(actionForEvent('doorbell')).toEqual({ type: 'doorbell' });
    expect(actionForEvent('online')).toEqual({ type: 'online' });
    expect(actionForEvent('offline')).toEqual({ type: 'offline' });
    expect(actionForEvent('battery', 40)).toEqual({ type: 'battery', percent: 40 });
    expect(actionForEvent('battery')).toEqual({ type: 'ignore' });
    expect(actionForEvent('face')).toEqual({ type: 'ignore' });
  });

  it('chooses NVR channels and keeps an explicit list', () => {
    const devices = [
      { channel: 0, online: false, name: 'Offline' },
      { channel: 1, online: true, name: 'Driveway' },
      { channel: -1, name: 'Bad' },
    ];
    expect(selectChannels(false, undefined, devices).map((device) => device.channel)).toEqual([0]);
    expect(selectChannels(true, undefined, devices).map((device) => device.name)).toEqual(['Driveway']);
    expect(selectChannels(true, [0, 3], devices)).toEqual([{ channel: 0, online: false, name: 'Offline' }, { channel: 3 }]);
    expect(selectChannels(true, undefined, [{ channel: 4, online: false }])).toEqual([{ channel: 0 }]);
    expect(selectChannels(false, [], [])).toEqual([{ channel: 0 }]);
  });

  it('turns pan, tilt, and zoom deltas into timed directions', () => {
    expect(clampAxis(200, -170, 170)).toBe(170);
    expect(clampAxis(-5, 1, 10)).toBe(1);
    const right = movesForTarget(PTZ_HOME, { pan: 10, tilt: 0.1, zoom: 1.01 });
    expect(right.moves.map((move) => move.command)).toEqual(['Right']);
    expect(right.position).toEqual({ pan: 10, tilt: 0.1, zoom: 1.01 });
    const left = movesForTarget({ pan: 0, tilt: 0, zoom: 5 }, { pan: -170, tilt: -20, zoom: 1 });
    expect(left.moves.map((move) => move.command)).toEqual(['Left', 'Down', 'ZoomOut']);
    expect(left.position).toEqual({ pan: -170, tilt: -20, zoom: 1 });
    const up = movesForTarget(PTZ_HOME, { tilt: 90, zoom: 10 });
    expect(up.moves.map((move) => move.command)).toEqual(['Up', 'ZoomIn']);
    expect(movesForTarget(PTZ_HOME, { pan: Number.NaN }).moves).toEqual([]);
    expect(movesForTarget({ pan: 10, tilt: 0, zoom: 1 }, {}).position.pan).toBe(10);
  });

  it('limits Matter labels and endpoint ids', () => {
    expect(limitLabel('  porch  ')).toBe('porch');
    expect(limitLabel('x'.repeat(40))).toHaveLength(32);
    expect(withSuffix('Front door camera', 'motion')).toBe('Front door camera motion');
    expect(withSuffix('x'.repeat(40), 'package')).toHaveLength(32);
    expect(withSuffix('camera', 'x'.repeat(40))).toBe('x'.repeat(32));
    expect(serialWithSuffix('SERIAL', 'siren')).toBe('SERIAL-siren');
    expect(serialWithSuffix('S'.repeat(40), 'package')).toHaveLength(32);
    expect(endpointId('SER 123', 0)).toBe('reolink-SER123-ch0');
    expect(endpointId('***', 1, 'motion')).toBe('reolink-camera-ch1-motion');
    expect(channelLabel('Porch', 'Cam', '10.0.0.2', 0, 1)).toBe('Porch');
    expect(channelLabel('Hub', 'Driveway', '10.0.0.2', 1, 2)).toBe('Hub Driveway');
    expect(channelLabel(undefined, 'Driveway', '10.0.0.2', 1, 2)).toBe('Driveway');
    expect(channelLabel('Hub', undefined, '10.0.0.2', 1, 2)).toBe('Hub 1');
    expect(channelLabel(undefined, undefined, '10.0.0.2', 1, 2)).toBe('10.0.0.2 1');
  });

  it('formats errors and drops objects from nodelink logs', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('plain');
    expect(errorText({ password: 'secret' })).toBe('Unknown error');
    const logger = createReolinkLogger(log);
    logger.log('hello', 1, true, 2n, new Error('nope'), { password: 'secret' });
    logger.info(undefined, { password: 'secret' });
    logger.warn('careful');
    logger.error('failed');
    logger.debug('detail');
    expect(log.info).toHaveBeenCalledWith('hello 1 true 2 nope');
    expect(log.info).toHaveBeenCalledWith('');
    expect(log.warn).toHaveBeenCalledWith('careful');
    expect(log.error).toHaveBeenCalledWith('failed');
    expect(log.debug).toHaveBeenCalledWith('detail');
    expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain('secret');
  });

  it('reads an RTSP port and rejects a missing or invalid one', () => {
    expect(rtspPort('rtsp://127.0.0.1:8554/stream')).toBe(8554);
    expect(rtspPort('rtsp://127.0.0.1/stream')).toBeUndefined();
    expect(rtspPort('not a url')).toBeUndefined();
    expect(rtspPort('rtsp://127.0.0.1:0/stream')).toBeUndefined();
  });

  it('holds occupancy and replaces the previous timer', async () => {
    vi.useFakeTimers();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const clear = vi.fn();
    armOccupancy(timers, '0:motion', 30, clear);
    armOccupancy(timers, '0:motion', 1, clear);
    await vi.advanceTimersByTimeAsync(1000);
    expect(clear).toHaveBeenCalledTimes(1);
    armOccupancy(timers, '0:person', 5, clear);
    clearOccupancyTimers(timers);
    await vi.advanceTimersByTimeAsync(5000);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(timers.size).toBe(0);
    vi.useRealTimers();
  });

  it('writes occupancy and logs a failed update', async () => {
    const endpoint = new MatterbridgeEndpoint(occupancySensor, { id: 'occupancy' }).createDefaultOccupancySensingClusterServer(false).addRequiredClusters();
    const update = vi.spyOn(endpoint, 'updateAttribute').mockResolvedValue(true);
    await setOccupancy(endpoint, true, log);
    expect(update).toHaveBeenCalledWith('OccupancySensing', 'occupancy', { occupied: true }, log);
    update.mockRejectedValueOnce(new Error('offline'));
    await setOccupancy(endpoint, false, log);
    expect(log.warn).toHaveBeenCalledWith('Failed to set occupancy on occupancy: offline');
    update.mockRestore();
  });

  it('creates, reloads, and replaces email push credentials', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'reolink-push-'));
    try {
      const filePath = path.join(dir, 'nested', 'push.json');
      const created = await loadOrCreatePushCredentials(filePath);
      expect(created.created).toBe(true);
      expect(created.username).toBe('reolink-push');
      expect(created.password.length).toBeGreaterThan(10);
      expect((await stat(filePath)).mode % 0o1000).toBe(0o600);
      const stored = JSON.parse(await readFile(filePath, 'utf8')) as { password: string };
      expect(stored.password).toBe(created.password);
      const loaded = await loadOrCreatePushCredentials(filePath);
      expect(loaded).toEqual({ ...created, created: false });
      await writeFile(filePath, 'null');
      expect((await loadOrCreatePushCredentials(filePath)).created).toBe(true);
      await writeFile(filePath, '1');
      expect((await loadOrCreatePushCredentials(filePath)).created).toBe(true);
      await writeFile(filePath, '{}');
      expect((await loadOrCreatePushCredentials(filePath)).created).toBe(true);
      await writeFile(filePath, JSON.stringify({ username: 'user' }));
      expect((await loadOrCreatePushCredentials(filePath)).created).toBe(true);
      await writeFile(filePath, JSON.stringify({ password: 'secret' }));
      expect((await loadOrCreatePushCredentials(filePath)).created).toBe(true);
      await writeFile(filePath, '{');
      const replaced = await loadOrCreatePushCredentials(filePath);
      expect(replaced.created).toBe(true);
      expect(replaced.password).not.toBe(created.password);
      await writeFile(filePath, JSON.stringify({ username: '', password: 1 }));
      const invalid = await loadOrCreatePushCredentials(filePath);
      expect(invalid.created).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('accepts a platform config value for devices', () => {
    const value: PlatformConfig['devices'] = [];
    expect(Array.isArray(value)).toBe(true);
  });
});
