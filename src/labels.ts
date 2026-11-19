/**
 * @file src/labels.ts
 * @description Build stable Matter names, serials, and endpoint ids.
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

const LABEL_LIMIT = 32;

/**
 * Trim a Matter label to 32 characters.
 *
 * @param {string} value Candidate label
 * @returns {string} Trimmed label, at most 32 characters
 */
export function limitLabel(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= LABEL_LIMIT ? trimmed : trimmed.slice(0, LABEL_LIMIT);
}

/**
 * Append a suffix without exceeding the Matter label limit.
 *
 * @param {string} base Device name
 * @param {string} suffix Word appended after a space, such as motion or siren
 * @returns {string} Label of at most 32 characters
 */
export function withSuffix(base: string, suffix: string): string {
  const full = `${base} ${suffix}`;
  if (full.length <= LABEL_LIMIT) return full;
  const room = LABEL_LIMIT - suffix.length - 1;
  if (room < 1) return suffix.slice(0, LABEL_LIMIT);
  return `${base.slice(0, room)} ${suffix}`;
}

/**
 * Build a serial that stays unique after a suffix and fits in 32 characters.
 *
 * @param {string} serial Base serial
 * @param {string} suffix Suffix without the leading hyphen
 * @returns {string} Serial of at most 32 characters
 */
export function serialWithSuffix(serial: string, suffix: string): string {
  const mark = `-${suffix}`;
  const room = LABEL_LIMIT - mark.length;
  return `${serial.slice(0, Math.max(1, room))}${mark}`;
}

/**
 * Build a stable endpoint id from a serial and channel.
 *
 * @param {string} serial Device serial
 * @param {number} channel Zero-based channel
 * @param {string | undefined} suffix Optional sensor or accessory suffix
 * @returns {string} Id containing only letters, numbers, hyphens, and underscores
 */
export function endpointId(serial: string, channel: number, suffix?: string): string {
  const safe = serial.replace(/[^A-Za-z0-9_-]/g, '');
  const base = `reolink-${safe.length > 0 ? safe : 'camera'}-ch${channel}`;
  return suffix === undefined ? base : `${base}-${suffix}`;
}

/**
 * Choose the display name for a channel.
 *
 * @param {string | undefined} configuredName Name from the plugin config
 * @param {string | undefined} channelName Name reported by the camera or NVR
 * @param {string} host Host used when no name is known
 * @param {number} channel Zero-based channel
 * @param {number} channelCount How many channels this host will expose
 * @returns {string} Label of at most 32 characters
 */
export function channelLabel(configuredName: string | undefined, channelName: string | undefined, host: string, channel: number, channelCount: number): string {
  if (channelCount === 1 && configuredName !== undefined) return limitLabel(configuredName);
  if (channelName !== undefined && configuredName !== undefined && channelCount > 1) return limitLabel(`${configuredName} ${channelName}`);
  if (channelName !== undefined) return limitLabel(channelName);
  if (configuredName !== undefined) return limitLabel(`${configuredName} ${channel}`);
  return limitLabel(`${host} ${channel}`);
}
