/**
 * @file src/matterTalk.ts
 * @description Detect whether the linked Matterbridge build can carry speaker audio.
 * @author RyanMorash
 * @created 2026-11-20
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

import type { Camera, FloodlightCamera, VideoDoorbell } from 'matterbridge/devices/camera';
import type { AnsiLogger } from 'matterbridge/logger';
import { CameraAvStreamManagement } from 'matterbridge/matter/clusters';

type CameraOptions = NonNullable<ConstructorParameters<typeof Camera>[2]>;
type DoorbellCameraOptions = NonNullable<NonNullable<ConstructorParameters<typeof VideoDoorbell>[2]>['cameraOptions']>;
type FloodlightCameraOptions = NonNullable<NonNullable<ConstructorParameters<typeof FloodlightCamera>[2]>['cameraOptions']>;
type OfferOptions = NonNullable<CameraOptions['weriftOfferOptions']>;

type HasKey<T, K extends string> = K extends keyof T ? true : false;

type TalkReady = [
  HasKey<CameraOptions, 'twoWayTalkSupport'>,
  HasKey<CameraOptions, 'speakerCapabilities'>,
  HasKey<DoorbellCameraOptions, 'twoWayTalkSupport'>,
  HasKey<DoorbellCameraOptions, 'speakerCapabilities'>,
  HasKey<FloodlightCameraOptions, 'twoWayTalkSupport'>,
  HasKey<FloodlightCameraOptions, 'speakerCapabilities'>,
  HasKey<OfferOptions, 'acceptRemoteAudio'>,
  HasKey<OfferOptions, 'onRemoteAudio'>,
  HasKey<OfferOptions, 'onSessionClosed'>,
][number] extends true
  ? true
  : false;

/**
 * False until Camera, VideoDoorbell, FloodlightCamera, and the WebRTC offer options accept speaker talk.
 * `false satisfies TalkReady` stops compiling when those keys appear, so the constant has to flip with the types.
 */
const LINKED_MATTERBRIDGE_ACCEPTS_TALK = false satisfies TalkReady;

/** Opus speaker description passed to Matterbridge when it accepts two-way talk. */
export const SPEAKER_CAPABILITIES: CameraAvStreamManagement.AudioCapabilities = {
  maxNumberOfChannels: 1,
  supportedCodecs: [CameraAvStreamManagement.AudioCodec.Opus],
  supportedSampleRates: [48000],
  supportedBitDepths: [16],
};

/** One block of controller microphone audio decoded by Matterbridge. */
export interface RemoteAudioFrame {
  /** WebRTC session that produced the samples. */
  readonly sessionId: number;
  /** Mono signed 16-bit samples. */
  readonly pcm: Int16Array;
  /** Sample rate of `pcm` in hertz. */
  readonly sampleRate: number;
}

/** Callbacks and the Matter duplex mode for one channel that can talk. */
export interface TalkEndpointHooks {
  /** Matter two-way talk mode derived from the camera. */
  readonly twoWayTalkSupport: CameraAvStreamManagement.TwoWayTalkSupportType;
  /**
   * Accept one microphone frame.
   *
   * @param {RemoteAudioFrame} frame Decoded controller audio
   * @returns {void}
   */
  onRemoteAudio(frame: RemoteAudioFrame): void;
  /**
   * Release the talker when its WebRTC session ends.
   *
   * @param {number} sessionId WebRTC session identifier
   * @returns {void}
   */
  onSessionClosed(sessionId: number): void;
}

let talkSupportOverride: boolean | undefined;
let talkNoticeSent = false;

/**
 * Report whether this Matterbridge build can deliver controller audio and advertise a speaker.
 *
 * The linked types decide the default. Tests can override it to exercise the path those types will take.
 *
 * @returns {boolean} True when talk options and remote PCM callbacks are accepted
 */
export function matterbridgeAcceptsTalk(): boolean {
  return talkSupportOverride ?? LINKED_MATTERBRIDGE_ACCEPTS_TALK;
}

/**
 * Override {@link matterbridgeAcceptsTalk} for tests. Pass undefined to follow the linked build.
 *
 * @param {boolean | undefined} value Forced result, or undefined to clear the override
 * @returns {void}
 */
export function setMatterbridgeTalkSupport(value: boolean | undefined): void {
  talkSupportOverride = value;
}

/**
 * Allow the one-time talk notice to be logged again.
 *
 * @returns {void}
 */
export function resetTalkNotice(): void {
  talkNoticeSent = false;
}

/**
 * Log once that a camera can talk but this Matterbridge build cannot play it.
 *
 * @param {AnsiLogger} log Platform logger
 * @returns {void}
 */
export function noteTalkUnavailable(log: AnsiLogger): void {
  if (talkNoticeSent) return;
  talkNoticeSent = true;
  log.info('Two-way talk stays off until Matterbridge can deliver controller audio to the camera speaker.');
}

/**
 * Copy remote-audio callbacks onto a WebRTC offer when Matterbridge accepts them.
 *
 * @template {object} T Offer object
 * @param {T} offer RTSP offer for the channel
 * @param {TalkEndpointHooks | undefined} talk Talk callbacks. Omitted when the channel cannot talk
 * @returns {T} The same offer
 */
export function attachTalk<T extends object>(offer: T, talk?: TalkEndpointHooks): T {
  if (talk === undefined || !matterbridgeAcceptsTalk()) return offer;
  const onRemoteAudio = (frame: RemoteAudioFrame): void => {
    talk.onRemoteAudio(frame);
  };
  const onSessionClosed = (sessionId: number): void => {
    talk.onSessionClosed(sessionId);
  };
  Object.assign(offer, { acceptRemoteAudio: true, onRemoteAudio, onSessionClosed });
  return offer;
}

/**
 * Speaker fields for a camera constructor, empty unless Matterbridge accepts them.
 *
 * @param {TalkEndpointHooks | undefined} talk Talk description, or undefined when talk is not offered
 * @returns {object} Fields to copy onto the camera options
 */
export function cameraTalkFields(talk?: TalkEndpointHooks): {
  twoWayTalkSupport?: CameraAvStreamManagement.TwoWayTalkSupportType;
  speakerCapabilities?: CameraAvStreamManagement.AudioCapabilities;
} {
  if (talk === undefined || !matterbridgeAcceptsTalk()) return {};
  return { twoWayTalkSupport: talk.twoWayTalkSupport, speakerCapabilities: SPEAKER_CAPABILITIES };
}
