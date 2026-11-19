/**
 * @file src/detection.ts
 * @description Map Reolink detection capabilities and simple events to sensor actions.
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

/** Occupancy sensor created for one detection class. */
export type SensorKind = 'motion' | 'person' | 'vehicle' | 'pet' | 'package';

/** What a simple event should do to Matter state. */
export type MatterAction =
  | { readonly type: 'occupancy'; readonly sensor: SensorKind }
  | { readonly type: 'doorbell' }
  | { readonly type: 'battery'; readonly percent: number }
  | { readonly type: 'online' }
  | { readonly type: 'offline' }
  | { readonly type: 'ignore' };

/** Primary Matter device chosen for a channel. */
export type PrimaryKind = 'doorbell' | 'floodlight' | 'camera';

const AI_SENSORS: Readonly<Record<string, SensorKind>> = {
  people: 'person',
  person: 'person',
  vehicle: 'vehicle',
  dog_cat: 'pet',
  pet: 'pet',
  animal: 'pet',
  package: 'package',
};

/**
 * Choose the composed Matter device for a channel.
 *
 * Doorbells stay video doorbells even when they also have a spotlight. Floodlight cameras are used
 * only when the channel is not a doorbell.
 *
 * @param {boolean} isDoorbell True when the channel reports doorbell support
 * @param {boolean} hasFloodlight True when the channel reports a floodlight or spotlight
 * @returns {PrimaryKind} Device kind to construct
 */
export function primaryKind(isDoorbell: boolean, hasFloodlight: boolean): PrimaryKind {
  if (isDoorbell) return 'doorbell';
  if (hasFloodlight) return 'floodlight';
  return 'camera';
}

/**
 * List occupancy sensors for the detections a channel actually supports.
 *
 * @param {boolean} motionEnabled True when motion or PIR detection is enabled
 * @param {string | undefined} detectType Comma-separated AiCfg detectType
 * @returns {SensorKind[]} Sensors to expose, with motion first
 */
export function sensorKinds(motionEnabled: boolean, detectType?: string): SensorKind[] {
  const kinds: SensorKind[] = [];
  if (motionEnabled) kinds.push('motion');
  if (detectType === undefined) return kinds;
  const seen = new Set<SensorKind>(kinds);
  for (const part of detectType.split(',')) {
    const kind = AI_SENSORS[part.trim().toLowerCase()];
    if (kind !== undefined && !seen.has(kind)) {
      seen.add(kind);
      kinds.push(kind);
    }
  }
  return kinds;
}

/**
 * Map a Reolink simple-event type to a Matter update.
 *
 * Face, day/night, and sleep events are ignored. A battery event without a percent is ignored.
 *
 * @param {string} type Simple event type
 * @param {number | undefined} batteryPercent Battery percent carried by a battery event
 * @returns {MatterAction} Update to apply
 */
export function actionForEvent(type: string, batteryPercent?: number): MatterAction {
  switch (type) {
    case 'motion':
      return { type: 'occupancy', sensor: 'motion' };
    case 'people':
      return { type: 'occupancy', sensor: 'person' };
    case 'vehicle':
      return { type: 'occupancy', sensor: 'vehicle' };
    case 'animal':
      return { type: 'occupancy', sensor: 'pet' };
    case 'package':
      return { type: 'occupancy', sensor: 'package' };
    case 'doorbell':
      return { type: 'doorbell' };
    case 'online':
      return { type: 'online' };
    case 'offline':
      return { type: 'offline' };
    case 'battery':
      return batteryPercent === undefined ? { type: 'ignore' } : { type: 'battery', percent: batteryPercent };
    default:
      return { type: 'ignore' };
  }
}
