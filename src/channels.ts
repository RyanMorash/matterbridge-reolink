/**
 * @file src/channels.ts
 * @description Choose which NVR or camera channels become Matter endpoints.
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

/** Identity known for one channel before capabilities are loaded. */
export interface ChannelSummary {
  /** Zero-based channel number. */
  readonly channel: number;
  /** False when the NVR reports the channel offline. */
  readonly online?: boolean;
  /** Channel name from the NVR summary. */
  readonly name?: string;
  /** Channel serial number when the summary has one. */
  readonly serialNumber?: string;
  /** Channel model when the summary has one. */
  readonly model?: string;
  /** Doorbell hint from the summary. Capabilities replace this later. */
  readonly isDoorbell?: boolean;
  /** Battery hint from the summary. */
  readonly isBattery?: boolean;
}

/**
 * Choose the channels to expose for one host.
 *
 * An explicit channel list is used as written, including channels the summary marks offline.
 * A standalone camera is channel 0. An NVR exposes online summary rows, or channel 0 when the summary is empty.
 *
 * @param {boolean} isNvr True when the host is an NVR or Home Hub
 * @param {readonly number[] | undefined} requested Explicit channel list from config
 * @param {readonly ChannelSummary[]} devices Summary rows
 * @returns {ChannelSummary[]} Channels to expose
 */
export function selectChannels(isNvr: boolean, requested: readonly number[] | undefined, devices: readonly ChannelSummary[]): ChannelSummary[] {
  const byChannel = new Map<number, ChannelSummary>();
  for (const device of devices) {
    if (Number.isInteger(device.channel) && device.channel >= 0) byChannel.set(device.channel, device);
  }
  if (requested !== undefined && requested.length > 0) {
    return requested.map((channel) => byChannel.get(channel) ?? { channel });
  }
  if (!isNvr) return [byChannel.get(0) ?? { channel: 0 }];
  const online = [...byChannel.values()].filter((device) => device.online !== false);
  if (online.length > 0) return online;
  return [{ channel: 0 }];
}
