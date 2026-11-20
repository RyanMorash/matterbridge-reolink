/**
 * @file src/hostSession.ts
 * @description Login to one Reolink host and expose its channels.
 * @author RyanMorash
 * @created 2026-11-19
 * @version 1.1.5
 * @license Apache-2.0
 *
 * Copyright 2026 RyanMorash.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { BaichuanRtspServer, type PtzCommand, type ReolinkBaichuanApi, type ReolinkSimpleEvent } from '@apocaliss92/nodelink-js';
import type { MatterbridgeEndpoint } from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';

import { readBatteryPercent, toBatChargeLevel, toBatPercentRemaining } from './battery.js';
import { type ChannelSummary, selectChannels } from './channels.js';
import type { NormalizedDevice } from './config.js';
import { createChannelDevices, liveViewOffer } from './createDevices.js';
import { actionForEvent, primaryKind, sensorKinds } from './detection.js';
import { channelLabel, endpointId, limitLabel } from './labels.js';
import { errorText, type createReolinkLogger } from './logger.js';
import { type TalkEndpointHooks, matterbridgeAcceptsTalk, noteTalkUnavailable } from './matterTalk.js';
import { armOccupancy, clearOccupancyTimers, setOccupancy } from './occupancy.js';
import { movesForTarget, PTZ_HOME, type PtzPosition } from './ptz.js';
import type { PushService } from './pushService.js';
import { rtspPort } from './rtsp.js';
import { TalkBridge, talkSupportFromAbility } from './talk.js';

/** Platform services a host session needs. */
export interface HostContext {
  /** Platform logger. */
  readonly log: AnsiLogger;
  /** Logger passed to nodelink. */
  readonly reolinkLogger: ReturnType<typeof createReolinkLogger>;
  /** Matter vendor id. */
  readonly vendorId: number;
  /** Occupancy hold in seconds. */
  readonly eventHoldSeconds: number;
  /** Battery poll interval in seconds. 0 disables polling. */
  readonly batteryPollSeconds: number;
  /** Delay before an RTSP proxy is restarted. 0 restarts on the next microtask. */
  readonly restartDelayMs: number;
  /** Write push settings to the camera when true. */
  readonly configurePush: boolean;
  /** Bridge IPv4 address. */
  readonly ipv4Address?: string;
  /** SMTP port. */
  readonly emailPort: number;
  /** Virtual mail domain. */
  readonly domain: string;
  /** SMTP username, when email push is enabled. */
  readonly pushUsername?: string;
  /** SMTP password, when email push is enabled. */
  readonly pushPassword?: string;
  /** Shared push intakes. */
  readonly push?: PushService;
  /**
   * Apply the platform whitelist and blacklist.
   *
   * @param {string[]} names Device name and serial
   * @returns {boolean} True when the device may be registered
   */
  validateDevice(names: string[]): boolean;
  /**
   * Publish a device in the frontend select list.
   *
   * @param {string} serial Device serial
   * @param {string} name Device name
   * @returns {void}
   */
  setSelectDevice(serial: string, name: string): void;
  /**
   * Register one bridged endpoint.
   *
   * @param {MatterbridgeEndpoint} device Endpoint to add
   * @returns {Promise<void>} Resolves when Matterbridge has accepted the device
   */
  registerDevice(device: MatterbridgeEndpoint): Promise<void>;
}

interface RtspSlot {
  channel: number;
  rtsp?: BaichuanRtspServer;
  rtspPort?: number;
}

interface ChannelRuntime extends RtspSlot {
  name: string;
  cameraId: string;
  hasBattery: boolean;
  position: PtzPosition;
  primary: MatterbridgeEndpoint;
  doorbell?: MatterbridgeEndpoint;
  light?: MatterbridgeEndpoint;
  siren?: MatterbridgeEndpoint;
  sensors: Map<string, MatterbridgeEndpoint>;
  talk?: TalkEndpointHooks;
}

/**
 * One Baichuan session and the Matter endpoints created from it.
 */
export class HostSession {
  private readonly channels = new Map<number, ChannelRuntime>();
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private readonly occupancyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pushOff: Array<() => void> = [];
  private readonly restarting = new Set<number>();
  private readonly talkBridges = new Map<number, TalkBridge>();
  private readonly republishTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly republishAttempt = new Map<number, number>();
  private readonly publishEpoch = new Map<number, number>();
  private readonly publishing = new Set<number>();
  private readonly unpublished = new Set<number>();
  private ptzChain: Promise<void> = Promise.resolve();
  private closed = false;
  private subscribed = false;
  private pushWarned = false;

  /**
   * Create a session for one configured host.
   *
   * @param {NormalizedDevice} device Normalized config entry
   * @param {HostContext} context Platform callbacks and settings
   * @param {ReolinkBaichuanApi} api Logged-out API client
   */
  constructor(
    private readonly device: NormalizedDevice,
    private readonly context: HostContext,
    private readonly api: ReolinkBaichuanApi,
  ) {}

  /**
   * Log in, expose allowed channels, and subscribe to events.
   *
   * A failed login is logged and skips this host. The password is not included in the log.
   *
   * @returns {Promise<void>} Resolves when discovery has finished or failed
   */
  async start(): Promise<void> {
    try {
      await this.api.login();
    } catch (error) {
      this.context.log.error(`Login failed for ${this.device.host}: ${errorText(error)}`);
      await this.safeClose();
      return;
    }
    const channels = await this.loadChannels();
    for (const channel of channels) await this.exposeChannel(channel, channels.length);
    if (this.channels.size === 0) {
      await this.safeClose();
      return;
    }
    try {
      await this.api.onSimpleEvent(this.onEvent);
      this.subscribed = true;
    } catch (error) {
      this.context.log.error(`Event subscription failed for ${this.device.host}: ${errorText(error)}`);
    }
  }

  /**
   * Read battery state again for every exposed battery channel.
   *
   * @returns {Promise<void>} Resolves when every read has been attempted
   */
  async refreshBatteries(): Promise<void> {
    for (const runtime of this.channels.values()) await this.publishBattery(runtime);
  }

  /**
   * Stop proxies, cancel timers, and close the Baichuan session.
   *
   * @returns {Promise<void>} Resolves when cleanup has been attempted
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.length = 0;
    for (const timer of this.republishTimers.values()) clearTimeout(timer);
    this.republishTimers.clear();
    clearOccupancyTimers(this.occupancyTimers);
    for (const off of this.pushOff) off();
    this.pushOff.length = 0;
    if (this.subscribed) {
      try {
        await this.api.offSimpleEvent(this.onEvent);
      } catch (error) {
        this.context.log.warn(`Event unsubscribe failed for ${this.device.host}: ${errorText(error)}`);
      }
      this.subscribed = false;
    }
    for (const runtime of this.channels.values()) await this.stopRtsp(runtime);
    for (const bridge of this.talkBridges.values()) await bridge.shutdown();
    this.talkBridges.clear();
    await this.safeClose();
  }

  private readonly onEvent = (event: ReolinkSimpleEvent): void => {
    void this.handleEvent(event).catch((error: unknown) => {
      this.context.log.error(`Event handling failed for ${this.device.host}: ${errorText(error)}`);
    });
  };

  /**
   * Resolve the channel list for this host.
   *
   * @returns {Promise<ChannelSummary[]>} Channels to consider
   */
  private async loadChannels(): Promise<ChannelSummary[]> {
    let isNvr = false;
    try {
      isNvr = await this.api.isNvrDevice();
    } catch (error) {
      this.context.log.warn(`NVR detection failed for ${this.device.host}: ${errorText(error)}`);
    }
    const devices: ChannelSummary[] = [];
    if (isNvr || this.device.channels !== undefined) {
      try {
        const summary = await this.api.getNvrChannelsSummary({ source: 'baichuan' });
        for (const device of summary.devices) {
          const row = toSummary(device);
          if (row !== undefined) devices.push(row);
        }
      } catch (error) {
        this.context.log.warn(`Channel summary failed for ${this.device.host}: ${errorText(error)}`);
      }
    }
    return selectChannels(isNvr, this.device.channels, devices);
  }

  /**
   * Expose one channel when the whitelist allows it.
   *
   * @param {ChannelSummary} summary Channel identity from discovery
   * @param {number} channelCount How many channels this host is considering
   * @returns {Promise<void>} Resolves when the channel is registered or skipped
   */
  private async exposeChannel(summary: ChannelSummary, channelCount: number): Promise<void> {
    const facts = await this.loadFacts(summary, channelCount);
    if (facts === undefined) return;
    this.context.setSelectDevice(facts.serial, facts.name);
    if (!this.context.validateDevice([facts.name, facts.serial])) return;
    const slot: RtspSlot = { channel: summary.channel };
    const rtspUrl = await this.startRtsp(slot);
    const cameraId = endpointId(facts.serial, summary.channel);
    const talk = await this.talkFor(summary.channel, cameraId, rtspUrl);
    const devices = createChannelDevices({ ...facts, rtspUrl, channel: summary.channel, ...(talk === undefined ? {} : { talk }) });
    const runtime: ChannelRuntime = {
      ...slot,
      name: facts.name,
      cameraId,
      hasBattery: facts.hasBattery,
      position: PTZ_HOME,
      primary: devices.primary,
      sensors: new Map(),
      ...(devices.doorbell === undefined ? {} : { doorbell: devices.doorbell }),
      ...(devices.light === undefined ? {} : { light: devices.light }),
      ...(devices.siren === undefined ? {} : { siren: devices.siren }),
      ...(talk === undefined ? {} : { talk }),
    };
    for (const [sensor, endpoint] of devices.sensors) runtime.sensors.set(sensor, endpoint);
    this.wireControls(runtime, facts.ptz);
    await this.registerAll(runtime, facts.kind);
    this.channels.set(summary.channel, runtime);
    if (runtime.rtsp === undefined && runtime.talk !== undefined) this.scheduleRestart(summary.channel);
    this.armPush(runtime);
    if (facts.hasBattery) {
      await this.publishBattery(runtime);
      this.armBatteryPoll(runtime);
    }
    this.context.log.info(`Exposed ${facts.name} on ${this.device.host} channel ${summary.channel}`);
  }

  /**
   * Load names, capabilities, and initial accessory state.
   *
   * @param {ChannelSummary} summary Discovery row
   * @param {number} channelCount Channel count used to build the label
   * @returns {Promise<object | undefined>} Facts for device creation, or undefined when capabilities cannot be read
   */
  private async loadFacts(summary: ChannelSummary, channelCount: number): Promise<Facts | undefined> {
    let infoName: string | undefined;
    let infoSerial: string | undefined;
    let infoModel: string | undefined;
    let firmware: string | undefined;
    try {
      const info = await this.api.getInfo(summary.channel);
      infoName = info.name;
      infoSerial = info.serialNumber;
      infoModel = info.type;
      firmware = info.firmwareVersion;
    } catch (error) {
      this.context.log.warn(`Device info failed for ${this.device.host} channel ${summary.channel}: ${errorText(error)}`);
    }
    let capabilities;
    try {
      capabilities = (await this.api.getDeviceCapabilities(summary.channel)).capabilities;
    } catch (error) {
      this.context.log.error(`Capabilities failed for ${this.device.host} channel ${summary.channel}: ${errorText(error)}`);
      return undefined;
    }
    const kind = primaryKind(capabilities.isDoorbell, capabilities.hasFloodlight);
    const motion = await this.motionEnabled(summary.channel, capabilities.hasPir);
    const detectType = await this.detectType(summary.channel);
    const version = softwareVersion(firmware);
    const serial = limitLabel(summary.serialNumber ?? infoSerial ?? `${this.device.host}-${summary.channel}`);
    return {
      name: channelLabel(this.device.name, summary.name ?? infoName, this.device.host, summary.channel, channelCount),
      serial,
      vendorId: this.context.vendorId,
      productName: (summary.model ?? infoModel ?? 'Reolink').slice(0, 64),
      softwareVersion: version.version,
      softwareVersionString: version.text,
      kind,
      hasBattery: capabilities.hasBattery,
      ptz: kind === 'camera' && capabilities.hasPtz,
      lightOn: capabilities.hasFloodlight ? await this.readEnabled(async () => this.api.getWhiteLedState(summary.channel)) : false,
      sirenOn: capabilities.hasSiren ? await this.readEnabled(async () => this.api.getSiren(summary.channel)) : false,
      extraLight: kind === 'doorbell' && capabilities.hasFloodlight,
      hasSiren: capabilities.hasSiren,
      sensors: sensorKinds(motion, detectType),
      holdSeconds: this.context.eventHoldSeconds,
    };
  }

  /**
   * Read whether motion detection is enabled.
   *
   * @param {number} channel Channel number
   * @param {boolean} hasPir PIR capability used when the motion read fails
   * @returns {Promise<boolean>} True when motion or PIR is available
   */
  private async motionEnabled(channel: number, hasPir: boolean): Promise<boolean> {
    try {
      return (await this.api.getMotionState(channel)) || hasPir;
    } catch (error) {
      this.context.log.debug(`Motion state failed for ${this.device.host} channel ${channel}: ${errorText(error)}`);
      return hasPir;
    }
  }

  /**
   * Read the AI detectType string.
   *
   * @param {number} channel Channel number
   * @returns {Promise<string | undefined>} detectType, or undefined when AI config is unavailable
   */
  private async detectType(channel: number): Promise<string | undefined> {
    try {
      const config = await this.api.getAiCfg(channel);
      return config.body?.AiCfg?.detectType;
    } catch (error) {
      this.context.log.debug(`AI config failed for ${this.device.host} channel ${channel}: ${errorText(error)}`);
      return undefined;
    }
  }

  /**
   * Read an enabled flag, treating failures as off.
   *
   * @param {() => Promise<{ enabled: boolean }>} read State reader
   * @returns {Promise<boolean>} Enabled flag
   */
  private async readEnabled(read: () => Promise<{ enabled: boolean }>): Promise<boolean> {
    try {
      return (await read()).enabled;
    } catch (error) {
      this.context.log.debug(`Accessory state failed for ${this.device.host}: ${errorText(error)}`);
      return false;
    }
  }

  /**
   * Build speaker callbacks when this channel can talk and Matterbridge can play the audio.
   *
   * @param {number} channel Zero-based channel
   * @param {string} deviceId Stable endpoint id passed to the talk socket
   * @param {string | undefined} rtspUrl Local RTSP URL, absent when the proxy did not start
   * @returns {Promise<TalkEndpointHooks | undefined>} Hooks for the camera, or undefined when talk stays off
   */
  private async talkFor(channel: number, deviceId: string, rtspUrl: string | undefined): Promise<TalkEndpointHooks | undefined> {
    const support = await this.readTalkSupport(channel);
    if (support === undefined) return undefined;
    if (!matterbridgeAcceptsTalk()) {
      noteTalkUnavailable(this.context.log);
      return undefined;
    }
    const bridge = new TalkBridge(
      channel,
      deviceId,
      async (talkChannel, options) => this.api.createDedicatedTalkSession(talkChannel, options),
      this.context.log,
      this.context.reolinkLogger,
    );
    bridge.setStreamReady(rtspUrl !== undefined);
    if (rtspUrl === undefined) this.context.log.debug(`Talk skipped for ${this.device.host} channel ${channel}: the RTSP proxy is not running`);
    this.talkBridges.set(channel, bridge);
    return {
      twoWayTalkSupport: support,
      onRemoteAudio: (frame) => {
        bridge.onRemoteAudio(frame);
      },
      onSessionClosed: (sessionId) => {
        bridge.onSessionClosed(sessionId);
      },
    };
  }

  /**
   * Read whether the channel can send ADPCM, and which duplex mode it offers.
   *
   * @param {number} channel Zero-based channel
   * @returns {Promise<ReturnType<typeof talkSupportFromAbility>>} Duplex mode, or undefined when talk is unavailable
   */
  private async readTalkSupport(channel: number): Promise<ReturnType<typeof talkSupportFromAbility>> {
    try {
      return talkSupportFromAbility(await this.api.getTalkAbility(channel));
    } catch (error) {
      this.context.log.debug(`Talk ability failed for ${this.device.host} channel ${channel}: ${errorText(error)}`);
      return undefined;
    }
  }

  /**
   * Subscribe light, siren, and PTZ commands.
   *
   * @param {ChannelRuntime} runtime Channel endpoints
   * @param {boolean} ptz True when mechanical PTZ commands should be forwarded
   * @returns {void}
   */
  private wireControls(runtime: ChannelRuntime, ptz: boolean): void {
    if (runtime.light !== undefined) {
      runtime.light.subscribeAttribute('OnOff', 'onOff', (value: unknown) => {
        if (typeof value !== 'boolean') return;
        void this.setLight(runtime, value);
      });
    }
    if (runtime.siren !== undefined) {
      runtime.siren.subscribeAttribute('OnOff', 'onOff', (value: unknown) => {
        if (typeof value !== 'boolean') return;
        void this.setSiren(runtime, value);
      });
    }
    if (!ptz) return;
    runtime.primary.subscribeCommand('CameraAvSettingsUserLevelManagement', 'mptzSetPosition', (data) => {
      this.enqueueMove(runtime, readPosition(data.request));
    });
    runtime.primary.subscribeCommand('CameraAvSettingsUserLevelManagement', 'mptzRelativeMove', (data) => {
      const request = data.request;
      this.enqueueMove(runtime, () => readRelative(request, runtime.position));
    });
    runtime.primary.subscribeCommand('CameraAvSettingsUserLevelManagement', 'mptzMoveToPreset', (data) => {
      const presetId = readNumber(data.request, 'presetId');
      if (presetId === undefined) return;
      this.enqueue(async () => {
        await this.api.moveToPtzPreset(presetId, runtime.channel);
      });
    });
  }

  /**
   * Register the primary device and its sibling accessories.
   *
   * @param {ChannelRuntime} runtime Channel endpoints
   * @param {'doorbell' | 'floodlight' | 'camera'} kind Primary device kind
   * @returns {Promise<void>} Resolves when registration has been attempted
   */
  private async registerAll(runtime: ChannelRuntime, kind: 'doorbell' | 'floodlight' | 'camera'): Promise<void> {
    await this.context.registerDevice(runtime.primary);
    for (const sensor of runtime.sensors.values()) await this.context.registerDevice(sensor);
    if (kind === 'doorbell' && runtime.light !== undefined) await this.context.registerDevice(runtime.light);
    if (runtime.siren !== undefined) await this.context.registerDevice(runtime.siren);
  }

  /**
   * Bridge email and webhook deliveries into this API and optionally arm the camera.
   *
   * @param {ChannelRuntime} runtime Exposed channel
   * @returns {void}
   */
  private armPush(runtime: ChannelRuntime): void {
    const push = this.context.push;
    if (push === undefined) return;
    push.register(runtime.cameraId);
    if (push.emailRunning) this.pushOff.push(this.api.subscribeEmailPushEvents({ cameraId: runtime.cameraId, channel: runtime.channel }));
    if (push.webhookRunning) this.pushOff.push(this.api.subscribeBaichuanWebhookEvents({ cameraId: runtime.cameraId, channel: runtime.channel }));
    if (!this.context.configurePush) return;
    void this.configurePush(runtime, push).catch((error: unknown) => {
      this.context.log.error(`Push configuration failed for ${this.device.host} channel ${runtime.channel}: ${errorText(error)}`);
    });
  }

  /**
   * Write the bridge address into the camera push settings.
   *
   * @param {ChannelRuntime} runtime Exposed channel
   * @param {PushService} push Running email or webhook intake
   * @returns {Promise<void>} Resolves when each requested write has been attempted
   */
  private async configurePush(runtime: ChannelRuntime, push: PushService): Promise<void> {
    if (this.context.ipv4Address === undefined) {
      if (!this.pushWarned) {
        this.pushWarned = true;
        this.context.log.warn(`Push configuration skipped for ${this.device.host}: the bridge IPv4 address is unknown`);
      }
      return;
    }
    if (push.emailRunning && this.context.pushUsername !== undefined && this.context.pushPassword !== undefined) {
      await this.api.setupEmailPushToManager(
        {
          managerHost: this.context.ipv4Address,
          managerPort: this.context.emailPort,
          recipientLocalPart: `cam-${runtime.cameraId}`,
          domain: this.context.domain,
          authUsername: this.context.pushUsername,
          authPassword: this.context.pushPassword,
          triggerTypes: ['md', 'people', 'vehicle', 'dog_cat', 'package', 'visitor'],
        },
        runtime.channel,
      );
    }
    const url = push.webhookUrl(runtime.cameraId);
    if (url !== undefined) await this.api.setupBaichuanWebhookToManager({ url });
  }

  /**
   * Apply one simple event to the matching channel.
   *
   * @param {ReolinkSimpleEvent} event Nodelink event
   * @returns {Promise<void>} Resolves when the update has been attempted
   */
  private async handleEvent(event: ReolinkSimpleEvent): Promise<void> {
    const runtime = this.channels.get(event.channel);
    if (runtime === undefined) return;
    const action = actionForEvent(event.type, readBatteryPercent(event.battery));
    if (action.type === 'occupancy') {
      const sensor = runtime.sensors.get(action.sensor);
      if (sensor === undefined) return;
      await setOccupancy(sensor, true, this.context.log);
      armOccupancy(this.occupancyTimers, `${runtime.channel}:${action.sensor}`, this.context.eventHoldSeconds, () => {
        void setOccupancy(sensor, false, this.context.log);
      });
      return;
    }
    if (action.type === 'doorbell') {
      if (runtime.doorbell === undefined) return;
      const delivered = await runtime.doorbell.triggerSwitchEvent('Single', this.context.log);
      if (!delivered) this.context.log.warn(`Doorbell press was not delivered for ${runtime.name}`);
      return;
    }
    if (action.type === 'battery') {
      await this.writeBattery(runtime, action.percent);
      return;
    }
    if (action.type === 'online') {
      if (runtime.rtsp === undefined || !runtime.rtsp.isActive()) this.scheduleRestart(runtime.channel);
      else if (this.unpublished.has(runtime.channel)) void this.publishOffer(runtime, runtime.rtsp.getRtspUrl());
      return;
    }
    if (action.type === 'offline') this.context.log.debug(`${runtime.name} reported offline`);
  }

  /**
   * Poll battery state on the configured interval.
   *
   * @param {ChannelRuntime} runtime Channel to poll
   * @returns {void}
   */
  private armBatteryPoll(runtime: ChannelRuntime): void {
    if (this.context.batteryPollSeconds <= 0) return;
    this.timers.push(
      setInterval(() => {
        void this.publishBattery(runtime);
      }, this.context.batteryPollSeconds * 1000),
    );
  }

  /**
   * Read and publish one channel's battery.
   *
   * @param {ChannelRuntime} runtime Channel whose battery should be read
   * @returns {Promise<void>} Resolves when the read has been attempted
   */
  private async publishBattery(runtime: ChannelRuntime): Promise<void> {
    if (!runtime.hasBattery || this.closed) return;
    try {
      const info = await this.api.getBatteryInfo(runtime.channel);
      const percent = readBatteryPercent(info);
      if (percent === undefined) return;
      const voltage = typeof info.voltage === 'number' && Number.isFinite(info.voltage) ? info.voltage : undefined;
      await this.writeBattery(runtime, percent, info.lowPower, voltage);
    } catch (error) {
      this.context.log.debug(`Battery read failed for ${this.device.host} channel ${runtime.channel}: ${errorText(error)}`);
    }
  }

  /**
   * Write Matter power-source attributes.
   *
   * @param {ChannelRuntime} runtime Channel whose primary device reports the battery
   * @param {number} percent Battery percent from 0 to 100
   * @param {number | undefined} lowPower Reolink low-power flag
   * @param {number | undefined} voltage Battery voltage in millivolts
   * @returns {Promise<void>} Resolves when the writes have been attempted
   */
  private async writeBattery(runtime: ChannelRuntime, percent: number, lowPower?: number, voltage?: number): Promise<void> {
    try {
      await runtime.primary.updateAttribute('PowerSource', 'batPercentRemaining', toBatPercentRemaining(percent), this.context.log);
      await runtime.primary.updateAttribute('PowerSource', 'batChargeLevel', toBatChargeLevel(percent, lowPower), this.context.log);
      if (voltage !== undefined) await runtime.primary.updateAttribute('PowerSource', 'batVoltage', voltage, this.context.log);
    } catch (error) {
      this.context.log.warn(`Battery update failed for ${runtime.name}: ${errorText(error)}`);
    }
  }

  /**
   * Turn the spotlight on or off.
   *
   * The floodlight probe runs first. The white LED command is still sent when the probe is negative or fails,
   * because that command is the toggle the library implements.
   *
   * @param {ChannelRuntime} runtime Channel being controlled
   * @param {boolean} on Requested state
   * @returns {Promise<void>} Resolves when the command has been attempted
   */
  private async setLight(runtime: ChannelRuntime, on: boolean): Promise<void> {
    try {
      const supported = await this.api.probeFloodlightSupportByCmd289(runtime.channel);
      this.context.log.debug(`Floodlight probe for ${this.device.host} channel ${runtime.channel}: ${supported}`);
    } catch (error) {
      this.context.log.debug(`Floodlight probe failed for ${this.device.host} channel ${runtime.channel}: ${errorText(error)}`);
    }
    try {
      await this.api.setWhiteLedState(on, undefined, runtime.channel);
    } catch (error) {
      this.context.log.error(`Light command failed for ${this.device.host} channel ${runtime.channel}: ${errorText(error)}`);
    }
  }

  /**
   * Turn the siren on or off.
   *
   * @param {ChannelRuntime} runtime Channel being controlled
   * @param {boolean} on Requested state
   * @returns {Promise<void>} Resolves when the command has been attempted
   */
  private async setSiren(runtime: ChannelRuntime, on: boolean): Promise<void> {
    try {
      await this.api.setSiren(on, undefined, runtime.channel);
    } catch (error) {
      this.context.log.error(`Siren command failed for ${this.device.host} channel ${runtime.channel}: ${errorText(error)}`);
    }
  }

  /**
   * Queue a mechanical move.
   *
   * @param {ChannelRuntime} runtime Camera being moved
   * @param {Partial<PtzPosition> | (() => Partial<PtzPosition>)} target Absolute target, or a function that reads it when the move runs. Omitted axes stay put.
   * @returns {void}
   */
  private enqueueMove(runtime: ChannelRuntime, target: Partial<PtzPosition> | (() => Partial<PtzPosition>)): void {
    this.enqueue(async () => {
      const planned = movesForTarget(runtime.position, typeof target === 'function' ? target() : target);
      for (const move of planned.moves) {
        const command: PtzCommand = { action: 'start', command: move.command, speed: move.speed, autoStopMs: move.autoStopMs };
        await this.api.ptz(runtime.channel, command);
      }
      runtime.position = planned.position;
    });
  }

  /**
   * Run PTZ work after the previous command for this host.
   *
   * @param {() => Promise<void>} work Command sequence
   * @returns {void}
   */
  private enqueue(work: () => Promise<void>): void {
    this.ptzChain = this.ptzChain.then(work).catch((error: unknown) => {
      this.context.log.error(`PTZ failed for ${this.device.host}: ${errorText(error)}`);
    });
  }

  /**
   * Start the localhost RTSP proxy for a channel.
   *
   * @param {ChannelRuntime} runtime Channel whose port is reused on restart
   * @returns {Promise<string | undefined>} RTSP URL, or undefined when the proxy did not start
   */
  private async startRtsp(runtime: RtspSlot): Promise<string | undefined> {
    try {
      const server = new BaichuanRtspServer({
        api: this.api,
        channel: runtime.channel,
        profile: this.device.profile,
        listenHost: '127.0.0.1',
        path: '/stream',
        logger: this.context.reolinkLogger,
        ...(runtime.rtspPort === undefined ? {} : { listenPort: runtime.rtspPort }),
      });
      server.on('close', () => {
        this.onRtspClosed(runtime.channel);
      });
      server.on('error', (error: Error) => {
        this.context.log.warn(`RTSP proxy error for ${this.device.host} channel ${runtime.channel}: ${errorText(error)}`);
        this.onRtspClosed(runtime.channel);
      });
      await server.start();
      const url = server.getRtspUrl();
      runtime.rtsp = server;
      const port = rtspPort(url);
      if (port !== undefined) runtime.rtspPort = port;
      return url;
    } catch (error) {
      this.context.log.error(`RTSP proxy failed for ${this.device.host} channel ${runtime.channel}: ${errorText(error)}`);
      return undefined;
    }
  }

  /**
   * Restart a proxy after an unexpected close, unless shutdown is in progress.
   *
   * @param {number} channel Channel whose proxy closed
   * @returns {void}
   */
  private onRtspClosed(channel: number): void {
    const runtime = this.channels.get(channel);
    if (this.closed || runtime?.rtsp === undefined || this.restarting.has(channel)) return;
    this.context.log.warn(`RTSP proxy closed for ${this.device.host} channel ${channel}`);
    this.scheduleRestart(channel);
  }

  /**
   * Schedule a proxy restart.
   *
   * @param {number} channel Channel to restart
   * @returns {void}
   */
  private scheduleRestart(channel: number): void {
    if (this.restarting.has(channel)) return;
    this.restarting.add(channel);
    const run = (): void => {
      void this.restartRtsp(channel);
    };
    if (this.context.restartDelayMs <= 0) {
      queueMicrotask(run);
      return;
    }
    this.timers.push(setTimeout(run, this.context.restartDelayMs));
  }

  /**
   * Stop and start one proxy again.
   *
   * @param {number} channel Channel to restart
   * @returns {Promise<void>} Resolves when the restart has been attempted
   */
  private async restartRtsp(channel: number): Promise<void> {
    const runtime = this.channels.get(channel);
    if (this.closed || runtime === undefined) {
      this.restarting.delete(channel);
      return;
    }
    this.publishEpoch.set(channel, this.readEpoch(channel) + 1);
    try {
      await this.stopRtsp(runtime);
      const url = await this.startRtsp(runtime);
      const bridge = this.talkBridges.get(channel);
      if (url === undefined) {
        bridge?.setStreamReady(false);
        this.unpublished.delete(channel);
        this.republishAttempt.delete(channel);
        this.cancelRepublish(channel);
        this.context.log.warn(`RTSP proxy did not restart for ${this.device.host} channel ${channel}`);
      } else await this.publishOffer(runtime, url);
    } finally {
      this.restarting.delete(channel);
    }
  }

  /**
   * Publish a proxy URL, and try again while that proxy stays up if the camera rejects the update.
   *
   * @param {ChannelRuntime} runtime Channel whose stream changed
   * @param {string} url Local RTSP url
   * @returns {Promise<void>} Resolves when the update has been attempted
   */
  private async publishOffer(runtime: ChannelRuntime, url: string): Promise<void> {
    const channel = runtime.channel;
    if (this.publishing.has(channel)) return;
    this.publishing.add(channel);
    const epoch = this.readEpoch(channel);
    try {
      const published = await this.publishStream(runtime, url);
      if (this.closed || this.readEpoch(channel) !== epoch) return;
      this.talkBridges.get(channel)?.setStreamReady(published);
      if (published) {
        this.unpublished.delete(channel);
        this.republishAttempt.delete(channel);
        this.cancelRepublish(channel);
        return;
      }
      this.unpublished.add(channel);
      this.scheduleRepublish(runtime);
    } finally {
      this.publishing.delete(channel);
    }
  }

  /**
   * Try the rejected stream update again without restarting a proxy that is still running.
   *
   * The first rejection is logged by {@link publishStream}. Later tries wait longer, up to 30 seconds, and stay quiet.
   *
   * @param {ChannelRuntime} runtime Channel whose offer was rejected
   * @returns {void}
   */
  private scheduleRepublish(runtime: ChannelRuntime): void {
    if (this.closed || this.republishTimers.has(runtime.channel)) return;
    const attempt = this.republishAttempt.get(runtime.channel) ?? 0;
    this.republishAttempt.set(runtime.channel, attempt + 1);
    const base = Math.max(this.context.restartDelayMs, 0);
    const timer = setTimeout(
      () => {
        this.republishTimers.delete(runtime.channel);
        const current = this.channels.get(runtime.channel);
        if (current?.rtsp === undefined || !current.rtsp.isActive()) return;
        void this.publishOffer(current, current.rtsp.getRtspUrl());
      },
      Math.min(base * 2 ** attempt, 30_000),
    );
    this.republishTimers.set(runtime.channel, timer);
  }

  /**
   * Read the publish generation for one channel.
   *
   * @param {number} channel Channel to read
   * @returns {number} Generation, or 0 before the first restart
   */
  private readEpoch(channel: number): number {
    return this.publishEpoch.get(channel) ?? 0;
  }

  /**
   * Stop a pending republish so a later success is not overwritten.
   *
   * @param {number} channel Channel whose retry should stop
   * @returns {void}
   */
  private cancelRepublish(channel: number): void {
    const timer = this.republishTimers.get(channel);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.republishTimers.delete(channel);
  }

  /**
   * Point Matter live view and snapshots at a replacement RTSP proxy.
   *
   * Composed cameras keep the WebRTC cluster on the Camera child. An endpoint that is not commissioned yet rejects
   * the state update. A later attempt publishes the same proxy again.
   *
   * @param {ChannelRuntime} runtime Channel whose stream changed
   * @param {string} url Local RTSP url
   * @returns {Promise<boolean>} True when the camera accepted the new offer
   */
  private async publishStream(runtime: ChannelRuntime, url: string): Promise<boolean> {
    const endpoint = runtime.primary.getChildEndpointById('Camera') ?? runtime.primary;
    try {
      await endpoint.setStateOf('webRtcTransportProvider', { weriftOfferOptions: liveViewOffer(url, runtime.talk) });
      return true;
    } catch (error) {
      const detail = `Stream source was not updated for ${this.device.host} channel ${runtime.channel}: ${errorText(error)}`;
      if (this.unpublished.has(runtime.channel)) this.context.log.debug(detail);
      else this.context.log.warn(detail);
      return false;
    }
  }

  /**
   * Stop one proxy without scheduling a restart.
   *
   * @param {ChannelRuntime} runtime Channel whose proxy should stop
   * @returns {Promise<void>} Resolves when stop has been attempted
   */
  private async stopRtsp(runtime: ChannelRuntime): Promise<void> {
    const server = runtime.rtsp;
    if (server === undefined) return;
    runtime.rtsp = undefined;
    try {
      await server.stop();
    } catch (error) {
      this.context.log.warn(`RTSP proxy stop failed for ${this.device.host} channel ${runtime.channel}: ${errorText(error)}`);
    }
    server.removeAllListeners();
  }

  /**
   * Close the API and log a failure.
   *
   * @returns {Promise<void>} Resolves when close has been attempted
   */
  private async safeClose(): Promise<void> {
    try {
      await this.api.close({ reason: 'matterbridge-reolink shutdown' });
    } catch (error) {
      this.context.log.warn(`Close failed for ${this.device.host}: ${errorText(error)}`);
    }
  }
}

interface Facts {
  name: string;
  serial: string;
  vendorId: number;
  productName: string;
  softwareVersion: number;
  softwareVersionString: string;
  kind: 'doorbell' | 'floodlight' | 'camera';
  hasBattery: boolean;
  ptz: boolean;
  lightOn: boolean;
  sirenOn: boolean;
  extraLight: boolean;
  hasSiren: boolean;
  sensors: ReturnType<typeof sensorKinds>;
  holdSeconds: number;
}

/**
 * Copy the summary fields the channel selector uses.
 *
 * @param {{ channel: number, online?: boolean, name?: string, serialNumber?: string, model?: string }} device NVR summary row
 * @returns {ChannelSummary | undefined} Summary, or undefined when the channel number is not usable
 */
function toSummary(device: { channel: number; online?: boolean; name?: string; serialNumber?: string; model?: string }): ChannelSummary | undefined {
  if (!Number.isInteger(device.channel) || device.channel < 0) return undefined;
  return {
    channel: device.channel,
    ...(device.online === undefined ? {} : { online: device.online }),
    ...(device.name === undefined ? {} : { name: device.name }),
    ...(device.serialNumber === undefined ? {} : { serialNumber: device.serialNumber }),
    ...(device.model === undefined ? {} : { model: device.model }),
  };
}

/**
 * Convert a firmware string into the numeric and text versions Matter basic information stores.
 *
 * @param {string | undefined} firmware Firmware version reported by the camera
 * @returns {{ version: number, text: string }} Software version fields
 */
function softwareVersion(firmware: string | undefined): { version: number; text: string } {
  const text = firmware !== undefined && firmware.length > 0 ? firmware.slice(0, 64) : '1.0.0';
  const parsed = Number((firmware ?? '').replace(/\D/g, '').slice(0, 8));
  return { version: Number.isFinite(parsed) && parsed > 0 ? parsed : 1, text };
}

/**
 * Read finite numeric fields from a command request.
 *
 * @param {unknown} request Command payload
 * @param {string} key Field name
 * @returns {number | undefined} Finite number, when present
 */
function readNumber(request: unknown, key: string): number | undefined {
  if (typeof request !== 'object' || request === null || !Object.hasOwn(request, key)) return undefined;
  const value = Reflect.get(request, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Read an absolute pan, tilt, and zoom target.
 *
 * @param {unknown} request MPTZSetPosition request
 * @returns {Partial<PtzPosition>} Fields that were present
 */
function readPosition(request: unknown): Partial<PtzPosition> {
  const pan = readNumber(request, 'pan');
  const tilt = readNumber(request, 'tilt');
  const zoom = readNumber(request, 'zoom');
  return { ...(pan === undefined ? {} : { pan }), ...(tilt === undefined ? {} : { tilt }), ...(zoom === undefined ? {} : { zoom }) };
}

/**
 * Add a relative move to the current position.
 *
 * @param {unknown} request MPTZRelativeMove request
 * @param {PtzPosition} current Last commanded position
 * @returns {Partial<PtzPosition>} Absolute target
 */
function readRelative(request: unknown, current: PtzPosition): Partial<PtzPosition> {
  const panDelta = readNumber(request, 'panDelta');
  const tiltDelta = readNumber(request, 'tiltDelta');
  const zoomDelta = readNumber(request, 'zoomDelta');
  return {
    ...(panDelta === undefined ? {} : { pan: current.pan + panDelta }),
    ...(tiltDelta === undefined ? {} : { tilt: current.tilt + tiltDelta }),
    ...(zoomDelta === undefined ? {} : { zoom: current.zoom + zoomDelta }),
  };
}
