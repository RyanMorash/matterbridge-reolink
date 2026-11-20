/**
 * @file src/createDevices.ts
 * @description Build Matter endpoints for one Reolink channel.
 * @author RyanMorash
 * @created 2026-11-19
 * @version 1.1.0
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

import { MatterbridgeEndpoint, occupancySensor, onOffPlugInUnit } from 'matterbridge';
import { Camera, FloodlightCamera, VideoDoorbell } from 'matterbridge/devices/camera';

import type { PrimaryKind, SensorKind } from './detection.js';
import { endpointId, serialWithSuffix, withSuffix } from './labels.js';
import { attachTalk, cameraTalkFields, type TalkEndpointHooks } from './matterTalk.js';

/** Matter endpoints created for one channel. */
export interface ChannelDevices {
  /** Camera, video doorbell, or floodlight camera. */
  readonly primary: MatterbridgeEndpoint;
  /** Doorbell child, present for video doorbells. */
  readonly doorbell?: MatterbridgeEndpoint;
  /** Floodlight child, or a sibling spotlight for a doorbell. */
  readonly light?: MatterbridgeEndpoint;
  /** Siren switch. */
  readonly siren?: MatterbridgeEndpoint;
  /** Occupancy sensors keyed by detection class. */
  readonly sensors: ReadonlyMap<SensorKind, MatterbridgeEndpoint>;
}

/** Values used to construct the endpoints for one channel. */
export interface ChannelDeviceInput {
  /** Display name of at most 32 characters. */
  readonly name: string;
  /** Stable serial of at most 32 characters. */
  readonly serial: string;
  /** Zero-based channel. */
  readonly channel: number;
  /** Matter vendor id copied from the bridge. */
  readonly vendorId: number;
  /** Product name reported on accessory endpoints. */
  readonly productName: string;
  /** Numeric software version. */
  readonly softwareVersion: number;
  /** Software version string. */
  readonly softwareVersionString: string;
  /** Which composed device to create. */
  readonly kind: PrimaryKind;
  /** True when the channel has a battery. */
  readonly hasBattery: boolean;
  /** True when a plain camera should expose mechanical PTZ. */
  readonly ptz: boolean;
  /** Initial spotlight state. */
  readonly lightOn: boolean;
  /** Initial siren state. */
  readonly sirenOn: boolean;
  /** True when a doorbell also has a spotlight. */
  readonly extraLight: boolean;
  /** True when the channel has a siren. */
  readonly hasSiren: boolean;
  /** Occupancy sensors to add. */
  readonly sensors: readonly SensorKind[];
  /** Occupancy hold in seconds. */
  readonly holdSeconds: number;
  /** Local RTSP URL. Omitted when the proxy did not start. */
  readonly rtspUrl?: string;
  /** Speaker talk for this channel. Omitted when the camera cannot talk or Matterbridge cannot play it. */
  readonly talk?: TalkEndpointHooks;
}

/**
 * WebRTC source options for a localhost RTSP proxy.
 *
 * @param {string | undefined} rtspUrl Local proxy URL
 * @returns {object | undefined} werift options, or undefined when there is no stream
 */
function streamOptions(
  rtspUrl: string | undefined,
): { offerVideo: true; offerAudio: true; videoSource: 'rtsp'; audioSource: 'rtsp'; videoSourceDevice: string; audioSourceDevice: string } | undefined {
  if (rtspUrl === undefined) return undefined;
  return {
    offerVideo: true,
    offerAudio: true,
    videoSource: 'rtsp',
    audioSource: 'rtsp',
    videoSourceDevice: rtspUrl,
    audioSourceDevice: rtspUrl,
  };
}

/**
 * Add bridged identity to an accessory endpoint.
 *
 * @param {MatterbridgeEndpoint} endpoint Endpoint to identify
 * @param {ChannelDeviceInput} input Channel identity
 * @param {string} name Accessory name
 * @param {string} serial Accessory serial
 * @returns {MatterbridgeEndpoint} The same endpoint
 */
function identify(endpoint: MatterbridgeEndpoint, input: ChannelDeviceInput, name: string, serial: string): MatterbridgeEndpoint {
  return endpoint.createDefaultBridgedDeviceBasicInformationClusterServer(
    name,
    serial,
    input.vendorId,
    'Reolink',
    input.productName,
    input.softwareVersion,
    input.softwareVersionString,
  );
}

/**
 * Create the camera, doorbell, sensors, light, and siren for one channel.
 *
 * @param {ChannelDeviceInput} input Channel identity and capabilities
 * @returns {ChannelDevices} Endpoints ready to register
 */
export function createChannelDevices(input: ChannelDeviceInput): ChannelDevices {
  const powerSourceType = input.hasBattery ? 'Rechargeable' : 'Wired';
  const rtspOffer = streamOptions(input.rtspUrl);
  const weriftOfferOptions = rtspOffer === undefined ? undefined : attachTalk(rtspOffer, input.talk);
  const id = endpointId(input.serial, input.channel);
  const primary = stamp(createPrimary(input, id, powerSourceType, weriftOfferOptions), input);
  const doorbell = input.kind === 'doorbell' ? primary.getChildEndpointById('Doorbell') : undefined;
  const composedLight = input.kind === 'floodlight' ? primary.getChildEndpointById('Light') : undefined;
  const light = composedLight ?? (input.extraLight ? createLight(input) : undefined);
  const siren = input.hasSiren ? createSiren(input) : undefined;
  const sensors = new Map<SensorKind, MatterbridgeEndpoint>();
  for (const sensor of input.sensors) sensors.set(sensor, createSensor(input, sensor));
  return { primary, ...(doorbell === undefined ? {} : { doorbell }), ...(light === undefined ? {} : { light }), ...(siren === undefined ? {} : { siren }), sensors };
}

/**
 * Copy the Reolink identity onto the primary endpoint.
 *
 * The composed camera classes publish their own basic information. Matterbridge copies these fields into the bridged
 * basic information cluster when the device is registered.
 *
 * @param {MatterbridgeEndpoint} endpoint Primary endpoint
 * @param {ChannelDeviceInput} input Channel identity
 * @returns {MatterbridgeEndpoint} The same endpoint
 */
function stamp(endpoint: MatterbridgeEndpoint, input: ChannelDeviceInput): MatterbridgeEndpoint {
  endpoint.vendorId = input.vendorId;
  endpoint.vendorName = 'Reolink';
  endpoint.productName = input.productName;
  endpoint.softwareVersion = input.softwareVersion;
  endpoint.softwareVersionString = input.softwareVersionString;
  return endpoint;
}

/**
 * Create the composed camera device.
 *
 * @param {ChannelDeviceInput} input Channel identity
 * @param {string} id Stable endpoint id
 * @param {'Rechargeable' | 'Wired'} powerSourceType Power source feature
 * @param {ReturnType<typeof streamOptions>} weriftOfferOptions Local RTSP source
 * @returns {MatterbridgeEndpoint} Camera, video doorbell, or floodlight camera
 */
function createPrimary(
  input: ChannelDeviceInput,
  id: string,
  powerSourceType: 'Rechargeable' | 'Wired',
  weriftOfferOptions: ReturnType<typeof streamOptions>,
): MatterbridgeEndpoint {
  const talkFields = cameraTalkFields(weriftOfferOptions === undefined ? undefined : input.talk);
  if (input.kind === 'doorbell') {
    const cameraOptions: NonNullable<NonNullable<ConstructorParameters<typeof VideoDoorbell>[2]>['cameraOptions']> = {};
    if (weriftOfferOptions !== undefined) cameraOptions.weriftOfferOptions = weriftOfferOptions;
    Object.assign(cameraOptions, talkFields);
    return new VideoDoorbell(input.name, input.serial, { id, powerSourceType, cameraOptions });
  }
  if (input.kind === 'floodlight') {
    const cameraOptions: NonNullable<NonNullable<ConstructorParameters<typeof FloodlightCamera>[2]>['cameraOptions']> = {};
    if (weriftOfferOptions !== undefined) cameraOptions.weriftOfferOptions = weriftOfferOptions;
    Object.assign(cameraOptions, talkFields);
    return new FloodlightCamera(input.name, input.serial, {
      id,
      powerSourceType,
      lightOptions: { name: 'Light', onOff: input.lightOn },
      cameraOptions,
    });
  }
  const options: NonNullable<ConstructorParameters<typeof Camera>[2]> = { id, powerSourceType, ptz: input.ptz };
  if (weriftOfferOptions !== undefined) options.weriftOfferOptions = weriftOfferOptions;
  Object.assign(options, talkFields);
  return new Camera(input.name, input.serial, options);
}

/**
 * Create a spotlight for a doorbell that also has a light.
 *
 * @param {ChannelDeviceInput} input Channel identity
 * @returns {MatterbridgeEndpoint} On/off plug used as the spotlight
 */
function createLight(input: ChannelDeviceInput): MatterbridgeEndpoint {
  const name = withSuffix(input.name, 'light');
  const serial = serialWithSuffix(input.serial, 'light');
  return identify(new MatterbridgeEndpoint(onOffPlugInUnit, { id: endpointId(input.serial, input.channel, 'light') }), input, name, serial)
    .createDefaultOnOffClusterServer(input.lightOn)
    .addRequiredClusters();
}

/**
 * Create the siren switch.
 *
 * @param {ChannelDeviceInput} input Channel identity
 * @returns {MatterbridgeEndpoint} On/off plug used as the siren
 */
function createSiren(input: ChannelDeviceInput): MatterbridgeEndpoint {
  const name = withSuffix(input.name, 'siren');
  const serial = serialWithSuffix(input.serial, 'siren');
  return identify(new MatterbridgeEndpoint(onOffPlugInUnit, { id: endpointId(input.serial, input.channel, 'siren') }), input, name, serial)
    .createDefaultOnOffClusterServer(input.sirenOn)
    .addRequiredClusters();
}

/**
 * Create one occupancy sensor.
 *
 * @param {ChannelDeviceInput} input Channel identity
 * @param {SensorKind} sensor Detection class
 * @returns {MatterbridgeEndpoint} Occupancy sensor
 */
function createSensor(input: ChannelDeviceInput, sensor: SensorKind): MatterbridgeEndpoint {
  const name = withSuffix(input.name, sensor);
  const serial = serialWithSuffix(input.serial, sensor);
  return identify(new MatterbridgeEndpoint(occupancySensor, { id: endpointId(input.serial, input.channel, sensor) }), input, name, serial)
    .createDefaultOccupancySensingClusterServer(false, input.holdSeconds)
    .addRequiredClusters();
}
