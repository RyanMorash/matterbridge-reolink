/**
 * @file src/occupancy.ts
 * @description Hold occupancy on and clear it after the configured delay.
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

import type { MatterbridgeEndpoint } from 'matterbridge';
import type { AnsiLogger } from 'matterbridge/logger';

import { errorText } from './logger.js';

/**
 * Write the OccupancySensing occupancy attribute.
 *
 * @param {MatterbridgeEndpoint} endpoint Occupancy sensor endpoint
 * @param {boolean} occupied True while the detection hold is active
 * @param {AnsiLogger} log Platform logger
 * @returns {Promise<void>} Resolves when the write has been attempted
 */
export async function setOccupancy(endpoint: MatterbridgeEndpoint, occupied: boolean, log: AnsiLogger): Promise<void> {
  try {
    await endpoint.updateAttribute('OccupancySensing', 'occupancy', { occupied }, log);
  } catch (error) {
    log.warn(`Failed to set occupancy on ${endpoint.deviceName ?? endpoint.id}: ${errorText(error)}`);
  }
}

/**
 * Keep one hold timer per sensor and replace it when the same detection repeats.
 *
 * @param {Map<string, ReturnType<typeof setTimeout>>} timers Timers keyed by channel and sensor
 * @param {string} key Timer key
 * @param {number} holdSeconds Hold time in seconds
 * @param {() => void} clear Callback that marks the sensor unoccupied
 * @returns {void}
 */
export function armOccupancy(timers: Map<string, ReturnType<typeof setTimeout>>, key: string, holdSeconds: number, clear: () => void): void {
  const existing = timers.get(key);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(
    () => {
      timers.delete(key);
      clear();
    },
    Math.max(0, holdSeconds) * 1000,
  );
  timers.set(key, timer);
}

/**
 * Cancel every occupancy hold timer.
 *
 * @param {Map<string, ReturnType<typeof setTimeout>>} timers Timers keyed by channel and sensor
 * @returns {void}
 */
export function clearOccupancyTimers(timers: Map<string, ReturnType<typeof setTimeout>>): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}
