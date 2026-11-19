/**
 * @file src/battery.ts
 * @description Convert Reolink battery readings to Matter Power Source values.
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

import { PowerSource } from 'matterbridge/matter/clusters';
import { isValidNumber } from 'matterbridge/utils';

/**
 * Read a battery percentage from a Reolink battery payload.
 *
 * @param {unknown} battery Battery object from a simple event or getBatteryInfo
 * @returns {number | undefined} Percent from 0 to 100, when the payload has one
 */
export function readBatteryPercent(battery: unknown): number | undefined {
  if (typeof battery !== 'object' || battery === null || !Object.hasOwn(battery, 'batteryPercent')) return undefined;
  const percent = Reflect.get(battery, 'batteryPercent');
  if (!isValidNumber(percent, 0, 100)) return undefined;
  return percent;
}

/**
 * Convert a percent to Matter batPercentRemaining.
 *
 * Matter stores the remaining charge in half-percent steps, from 0 to 200.
 *
 * @param {number} percent Battery percent from 0 to 100
 * @returns {number} Half-percent value from 0 to 200
 */
export function toBatPercentRemaining(percent: number): number {
  return Math.min(200, Math.max(0, Math.round(percent * 2)));
}

/**
 * Map a percent and the Reolink low-power flag to a Matter charge level.
 *
 * @param {number} percent Battery percent from 0 to 100
 * @param {number | undefined} lowPower Reolink low-power flag, 1 when the camera reports low power
 * @returns {PowerSource.BatChargeLevel} Matter charge level
 */
export function toBatChargeLevel(percent: number, lowPower?: number): PowerSource.BatChargeLevel {
  if (lowPower === 1 || percent <= 10) return PowerSource.BatChargeLevel.Critical;
  if (percent <= 20) return PowerSource.BatChargeLevel.Warning;
  return PowerSource.BatChargeLevel.Ok;
}
