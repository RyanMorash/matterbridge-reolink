/**
 * @file src/config.ts
 * @description Normalize the Reolink platform configuration.
 * @author RyanMorash
 * @created 2026-11-19
 * @version 1.0.0
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

import type { PlatformConfig } from 'matterbridge';
import { isValidArray, isValidNumber, isValidObject, isValidString } from 'matterbridge/utils';

/** Plugin config stored by Matterbridge. Fields are optional until normalized. */
export interface ReolinkPlatformConfig extends PlatformConfig {
  /** Device names or serials to expose. Empty exposes every discovered device. */
  whiteList?: string[];
  /** Device names or serials to hide. */
  blackList?: string[];
  /** Raw camera list. Normalized before use. */
  devices?: object;
  /** Occupancy hold in seconds. */
  eventHoldSeconds?: number;
  /** Battery poll interval in seconds. 0 disables polling. */
  batteryPollSeconds?: number;
  /** Asleep-camera intake mode. */
  push?: string;
  /** Write push settings to the camera when true. */
  configurePush?: boolean;
  /** SMTP listen port. */
  emailPushPort?: number;
  /** HaCfg webhook listen port. */
  webhookPort?: number;
  /** Virtual mail domain. */
  emailPushDomain?: string;
}

/** Baichuan stream profile proxied to Matter. */
export type StreamProfileName = 'main' | 'sub' | 'ext';

/** Asleep-camera event intake. */
export type PushMode = 'none' | 'email' | 'webhook' | 'both';

/** One configured camera, doorbell, or NVR host. */
export interface NormalizedDevice {
  /** IP address or hostname. */
  readonly host: string;
  /** Baichuan username. */
  readonly username: string;
  /** Baichuan password. */
  readonly password: string;
  /** Optional display name. */
  readonly name?: string;
  /** Baichuan port, 1-65535. */
  readonly port: number;
  /** Reolink UID for UDP cameras. */
  readonly uid?: string;
  /** Explicit transport. Omitted values use the library default. */
  readonly transport?: 'tcp' | 'udp';
  /** Explicit channel list. Empty means discover. */
  readonly channels?: number[];
  /** Stream profile. */
  readonly profile: StreamProfileName;
}

/** Normalized platform behavior that is not a device entry. */
export interface NormalizedSettings {
  /** Occupancy hold in seconds, 1-300. */
  readonly eventHoldSeconds: number;
  /** Battery poll interval in seconds. 0 disables polling. */
  readonly batteryPollSeconds: number;
  /** Which push intakes to start. */
  readonly push: PushMode;
  /** Write the bridge address into the camera when true. */
  readonly configurePush: boolean;
  /** SMTP listen port. */
  readonly emailPushPort: number;
  /** HaCfg webhook listen port. */
  readonly webhookPort: number;
  /** Virtual mail domain. */
  readonly emailPushDomain: string;
}

/** Result of reading a plugin config object. */
export interface NormalizedConfig extends NormalizedSettings {
  /** Hosts that passed validation. */
  readonly devices: NormalizedDevice[];
  /** Human-readable reasons for skipped input. */
  readonly warnings: string[];
}

/**
 * Narrow an unknown value to a push mode.
 *
 * @param {unknown} value Raw config value
 * @returns {boolean} True when value is a supported push mode
 */
function isPushMode(value: unknown): value is PushMode {
  return value === 'none' || value === 'email' || value === 'webhook' || value === 'both';
}

/**
 * Narrow an unknown value to a stream profile.
 *
 * @param {unknown} value Raw config value
 * @returns {boolean} True when value is main, sub, or ext
 */
function isProfile(value: unknown): value is StreamProfileName {
  return value === 'main' || value === 'sub' || value === 'ext';
}

/**
 * Clamp a finite number into an inclusive range.
 *
 * @param {number} value Candidate value
 * @param {number} min Inclusive lower bound
 * @param {number} max Inclusive upper bound
 * @param {number} fallback Value used when value is not finite
 * @returns {number} Clamped value, or fallback
 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (!isValidNumber(value, min, max)) return fallback;
  return Math.trunc(value);
}

/**
 * Read one device object.
 *
 * @param {unknown} value Raw device entry
 * @param {number} index Position in the devices array, used in warnings
 * @returns {{ device?: NormalizedDevice, warning?: string }} The device, or a warning
 */
function readDevice(value: unknown, index: number): { device?: NormalizedDevice; warning?: string } {
  if (!isValidObject(value, 1)) return { warning: `Skipped device ${index}: expected an object` };
  const host = Reflect.get(value, 'host');
  const username = Reflect.get(value, 'username');
  const password = Reflect.get(value, 'password');
  if (!isValidString(host, 1) || !isValidString(username, 1) || !isValidString(password, 1)) {
    return { warning: `Skipped device ${index}: host, username, and password are required` };
  }
  const name = optionalText(Reflect.get(value, 'name'));
  const uid = optionalText(Reflect.get(value, 'uid'));
  const transport = Reflect.get(value, 'transport');
  const profile = Reflect.get(value, 'profile');
  const channels = readChannels(Reflect.get(value, 'channels'));
  const device: NormalizedDevice = {
    host: host.trim(),
    username,
    password,
    port: clampNumber(Reflect.get(value, 'port'), 1, 65535, 9000),
    profile: isProfile(profile) ? profile : 'sub',
    ...optionalDeviceFields(uid, transport, channels),
    ...(name === undefined ? {} : { name }),
  };
  return { device };
}

/**
 * Trim a string and drop values that are empty after trimming.
 *
 * @param {unknown} value Raw config string
 * @returns {string | undefined} Trimmed text, when it is not empty
 */
function optionalText(value: unknown): string | undefined {
  if (!isValidString(value, 1)) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Copy optional device fields that passed validation.
 *
 * @param {string | undefined} uid Trimmed UID
 * @param {unknown} transport Raw transport
 * @param {number[] | undefined} channels Validated channel list
 * @returns {Pick<NormalizedDevice, 'uid' | 'transport' | 'channels'>} Optional fields
 */
function optionalDeviceFields(uid: string | undefined, transport: unknown, channels: number[] | undefined): Pick<NormalizedDevice, 'uid' | 'transport' | 'channels'> {
  return {
    ...(uid === undefined ? {} : { uid }),
    ...(transport === 'tcp' || transport === 'udp' ? { transport } : {}),
    ...(channels === undefined ? {} : { channels }),
  };
}

/**
 * Keep non-negative integer channel numbers.
 *
 * @param {unknown} value Raw channels field
 * @returns {number[] | undefined} Unique channels, or undefined when the field is absent or empty
 */
function readChannels(value: unknown): number[] | undefined {
  if (!isValidArray(value, 1)) return undefined;
  const channels: number[] = [];
  for (const entry of value) {
    if (isValidNumber(entry, 0, 255) && Number.isInteger(entry) && !channels.includes(entry)) channels.push(entry);
  }
  return channels.length > 0 ? channels : undefined;
}

/**
 * Normalize a plugin config into devices and settings.
 *
 * Invalid device entries are dropped. Numeric settings are clamped into the schema ranges.
 *
 * @param {ReolinkPlatformConfig} config Plugin config from Matterbridge
 * @returns {NormalizedConfig} Devices, settings, and warnings
 */
export function normalizeConfig(config: ReolinkPlatformConfig): NormalizedConfig {
  const devices: NormalizedDevice[] = [];
  const warnings: string[] = [];
  const rawDevices = Reflect.get(config, 'devices');
  if (rawDevices !== undefined && !isValidArray(rawDevices)) warnings.push('Ignored devices: expected an array');
  if (isValidArray(rawDevices)) {
    rawDevices.forEach((entry, index) => {
      const read = readDevice(entry, index);
      if (read.warning !== undefined) warnings.push(read.warning);
      if (read.device !== undefined) devices.push(read.device);
    });
  }
  const push = Reflect.get(config, 'push');
  return {
    devices,
    warnings,
    eventHoldSeconds: clampNumber(config.eventHoldSeconds, 1, 300, 30),
    batteryPollSeconds: clampNumber(config.batteryPollSeconds, 0, 86400, 300),
    push: isPushMode(push) ? push : 'none',
    configurePush: config.configurePush === true,
    emailPushPort: clampNumber(config.emailPushPort, 1, 65535, 2525),
    webhookPort: clampNumber(config.webhookPort, 1, 65535, 9081),
    emailPushDomain: optionalText(config.emailPushDomain) ?? 'reolink.local',
  };
}
