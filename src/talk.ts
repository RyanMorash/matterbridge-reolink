/**
 * @file src/talk.ts
 * @description Map Reolink talk ability and forward controller PCM to a dedicated talk session.
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

import { encodeImaAdpcm, type Logger, type TalkAbility, type TalkSession } from '@apocaliss92/nodelink-js';
import type { AnsiLogger } from 'matterbridge/logger';
import { CameraAvStreamManagement } from 'matterbridge/matter/clusters';

import { errorText } from './logger.js';
import type { RemoteAudioFrame } from './matterTalk.js';

const FULL_DUPLEX = new Set(['full', 'fdx', 'fd', 'fullduplex', 'full-duplex', 'full_duplex']);

/** How long a dedicated talk socket stays open after the last audio send, in milliseconds. */
export const TALK_IDLE_MS = 10_000;

/** Options passed to nodelink when a talk socket is opened. */
export interface TalkOpenOptions {
  /** Close the socket after this many milliseconds without audio. */
  readonly idleTimeoutMs: number;
  /** Stable channel id used in nodelink logs. */
  readonly deviceId: string;
  /** Logger that must not receive the camera password. */
  readonly logger?: Logger;
}

/** Opens one dedicated Baichuan talk session. */
export type TalkOpener = (channel: number, options: TalkOpenOptions) => Promise<TalkSession>;

/**
 * Clamp one PCM sample into signed 16-bit range.
 *
 * @param {number} sample Sample that may be fractional or non-finite
 * @returns {number} Integer from -32768 to 32767, or 0 when the sample is not finite
 */
export function clampPcmSample(sample: number): number {
  if (!Number.isFinite(sample)) return 0;
  return Math.max(-32768, Math.min(32767, Math.round(sample)));
}

/**
 * Resample mono signed 16-bit PCM with linear interpolation.
 *
 * @param {Int16Array} pcm Input samples
 * @param {number} fromRate Input sample rate in hertz
 * @param {number} toRate Output sample rate in hertz
 * @returns {Int16Array} Resampled samples, or an empty array when a rate is not usable
 */
export function resampleMono(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (pcm.length === 0 || !Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) return new Int16Array();
  if (fromRate === toRate) return pcm.slice();
  const outLength = Math.max(1, Math.round((pcm.length * toRate) / fromRate));
  const out = new Int16Array(outLength);
  const scale = (pcm.length - 1) / Math.max(1, outLength - 1);
  for (let index = 0; index < outLength; index += 1) {
    const position = index * scale;
    const left = Math.floor(position);
    const right = Math.min(left + 1, pcm.length - 1);
    const fraction = position - left;
    out[index] = clampPcmSample(pcm[left] * (1 - fraction) + pcm[right] * fraction);
  }
  return out;
}

/**
 * Choose the Matter duplex mode from a TalkAbility payload.
 *
 * ADPCM is required. A full-duplex token selects FullDuplex. Any other ADPCM ability is HalfDuplex.
 *
 * @param {TalkAbility} ability Camera talk ability
 * @returns {CameraAvStreamManagement.TwoWayTalkSupportType | undefined} Duplex mode, or undefined when the camera cannot talk
 */
export function talkSupportFromAbility(ability: TalkAbility): CameraAvStreamManagement.TwoWayTalkSupportType | undefined {
  const configs = ability.audioConfigList;
  if (!Array.isArray(configs) || !configs.some((config) => config.audioType.trim().toLowerCase() === 'adpcm')) return undefined;
  const tokens = Array.isArray(ability.duplexList) ? ability.duplexList : [];
  const full = tokens.some((token) => FULL_DUPLEX.has(token.trim().toLowerCase()));
  return full ? CameraAvStreamManagement.TwoWayTalkSupportType.FullDuplex : CameraAvStreamManagement.TwoWayTalkSupportType.HalfDuplex;
}

/**
 * Report whether a controller frame can be forwarded.
 *
 * @param {RemoteAudioFrame} frame Candidate frame
 * @returns {boolean} True when the session id, PCM, and sample rate are usable
 */
export function isRemoteAudioFrame(frame: RemoteAudioFrame): boolean {
  return (
    Number.isInteger(frame.sessionId) &&
    frame.sessionId >= 0 &&
    frame.pcm instanceof Int16Array &&
    frame.pcm.length > 0 &&
    Number.isFinite(frame.sampleRate) &&
    frame.sampleRate > 0
  );
}

/**
 * Forward one WebRTC talker to a single Reolink talk session.
 */
export class TalkBridge {
  private generation = 0;
  private activeSessionId: number | undefined;
  private failedSessionId: number | undefined;
  private session: TalkSession | undefined;
  private sampleRate = 0;
  private blockSize = 0;
  private pending: RemoteAudioFrame[] = [];
  private leftover = new Int16Array();
  private sendChain: Promise<void> = Promise.resolve();
  private releasing: Promise<void> | undefined;
  private closed = false;
  private loggedSecondTalker = false;

  /**
   * Create a bridge that opens its socket on the first valid frame.
   *
   * @param {number} channel Zero-based Baichuan channel
   * @param {string} deviceId Stable id passed to nodelink
   * @param {TalkOpener} open Dedicated session factory
   * @param {AnsiLogger} log Platform logger
   * @param {Logger | undefined} reolinkLogger Logger forwarded to nodelink
   */
  constructor(
    private readonly channel: number,
    private readonly deviceId: string,
    private readonly open: TalkOpener,
    private readonly log: AnsiLogger,
    private readonly reolinkLogger?: Logger,
  ) {}

  /**
   * Queue controller audio. A second WebRTC session is ignored until the first one closes.
   *
   * @param {RemoteAudioFrame} frame Decoded microphone audio
   * @returns {void}
   */
  onRemoteAudio(frame: RemoteAudioFrame): void {
    if (this.closed || !isRemoteAudioFrame(frame) || this.failedSessionId === frame.sessionId) return;
    if (this.activeSessionId !== undefined && this.activeSessionId !== frame.sessionId) {
      this.logSecondTalker();
      return;
    }
    if (this.activeSessionId === undefined) this.begin(frame.sessionId);
    this.pending.push(frame);
    this.pump();
  }

  /**
   * Stop talking when the owning WebRTC session ends.
   *
   * @param {number} sessionId WebRTC session identifier
   * @returns {void}
   */
  onSessionClosed(sessionId: number): void {
    if (sessionId !== this.activeSessionId && sessionId !== this.failedSessionId) return;
    void this.release();
  }

  /**
   * Stop the talk socket and refuse later audio.
   *
   * @returns {Promise<void>} Resolves when the session stop has been attempted
   */
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.release();
    await this.sendChain;
  }

  /**
   * Open a talk socket for the first talker.
   *
   * @param {number} sessionId WebRTC session identifier
   * @returns {void}
   */
  private begin(sessionId: number): void {
    this.generation += 1;
    this.activeSessionId = sessionId;
    void this.start(this.generation, sessionId);
  }

  /**
   * Open the dedicated session and encode any audio that arrived while it was opening.
   *
   * @param {number} generation Generation captured when the open started
   * @param {number} sessionId WebRTC session identifier
   * @returns {Promise<void>} Resolves when the open has succeeded, failed, or been discarded
   */
  private async start(generation: number, sessionId: number): Promise<void> {
    let session: TalkSession;
    try {
      session = await this.open(this.channel, {
        idleTimeoutMs: TALK_IDLE_MS,
        deviceId: this.deviceId,
        ...(this.reolinkLogger === undefined ? {} : { logger: this.reolinkLogger }),
      });
    } catch (error) {
      this.failOpen(generation, sessionId, error);
      return;
    }
    if (generation !== this.generation || this.closed) {
      await this.stopQuiet(session);
      return;
    }
    if (!this.adopt(session)) {
      this.failedSessionId = sessionId;
      this.activeSessionId = undefined;
      this.pending = [];
      await this.stopQuiet(session);
      return;
    }
    this.pump();
  }

  /**
   * Remember a failed open so later frames from that WebRTC session are dropped.
   *
   * @param {number} generation Generation captured when the open started
   * @param {number} sessionId WebRTC session identifier
   * @param {unknown} error Open failure
   * @returns {void}
   */
  private failOpen(generation: number, sessionId: number, error: unknown): void {
    if (generation !== this.generation || this.closed) return;
    this.log.error(`Talk session failed for channel ${this.channel}: ${errorText(error)}`);
    this.failedSessionId = sessionId;
    this.activeSessionId = undefined;
    this.pending = [];
  }

  /**
   * Store a session whose sample rate and block size can be used.
   *
   * @param {TalkSession} session Open talk session
   * @returns {boolean} True when the session was stored
   */
  private adopt(session: TalkSession): boolean {
    const rate = session.info.audioConfig.sampleRate;
    const block = session.info.blockSize;
    if (!Number.isFinite(rate) || rate <= 0 || !Number.isInteger(block) || block <= 0) {
      this.log.error(`Talk session for channel ${this.channel} reported an unusable audio format`);
      return false;
    }
    this.session = session;
    this.sampleRate = rate;
    this.blockSize = block;
    return true;
  }

  /**
   * Encode queued PCM into whole ADPCM blocks.
   *
   * @returns {void}
   */
  private pump(): void {
    const session = this.session;
    if (session === undefined) return;
    this.consumePending();
    const samplesPerBlock = this.blockSize * 2 + 1;
    while (this.leftover.length >= samplesPerBlock) {
      const block = this.leftover.slice(0, samplesPerBlock);
      this.leftover = this.leftover.slice(samplesPerBlock);
      this.enqueueSend(session, block);
    }
  }

  /**
   * Resample queued frames into the leftover PCM buffer.
   *
   * @returns {void}
   */
  private consumePending(): void {
    const frames = this.pending;
    this.pending = [];
    for (const frame of frames) this.appendSamples(resampleMono(frame.pcm, frame.sampleRate, this.sampleRate));
  }

  /**
   * Append samples to the leftover buffer.
   *
   * @param {Int16Array} samples Resampled PCM
   * @returns {void}
   */
  private appendSamples(samples: Int16Array): void {
    const merged = new Int16Array(this.leftover.length + samples.length);
    merged.set(this.leftover, 0);
    merged.set(samples, this.leftover.length);
    this.leftover = merged;
  }

  /**
   * Send one ADPCM block after earlier blocks, and tear the session down if the send fails.
   *
   * @param {TalkSession} session Session that accepts the block
   * @param {Int16Array} block PCM samples for one ADPCM block
   * @returns {void}
   */
  private enqueueSend(session: TalkSession, block: Int16Array): void {
    const generation = this.generation;
    this.sendChain = this.sendChain.then(async () => this.deliver(session, block, generation));
  }

  /**
   * Send one block unless this talker has already been replaced.
   *
   * @param {TalkSession} session Session that accepts the block
   * @param {Int16Array} block PCM samples for one ADPCM block
   * @param {number} generation Generation captured when the block was queued
   * @returns {Promise<void>} Resolves when the send has been attempted or skipped
   */
  private async deliver(session: TalkSession, block: Int16Array, generation: number): Promise<void> {
    if (generation !== this.generation) return;
    try {
      await session.sendAudio(encodeImaAdpcm(block, this.blockSize));
    } catch (error) {
      if (generation !== this.generation) return;
      this.log.error(`Talk audio failed for channel ${this.channel}: ${errorText(error)}`);
      await this.release();
    }
  }

  /**
   * Log the first ignored talker for the current session.
   *
   * @returns {void}
   */
  private logSecondTalker(): void {
    if (this.loggedSecondTalker) return;
    this.loggedSecondTalker = true;
    this.log.info(`Ignoring a second talker on channel ${this.channel}`);
  }

  /**
   * Drop the active talker and stop its socket once.
   *
   * @returns {Promise<void>} Resolves when the stop has been attempted
   */
  private async release(): Promise<void> {
    this.releasing ??= this.finishRelease().finally(() => {
      this.releasing = undefined;
    });
    await this.releasing;
  }

  /**
   * Clear talk state and stop the current socket.
   *
   * @returns {Promise<void>} Resolves when the stop has been attempted
   */
  private async finishRelease(): Promise<void> {
    this.generation += 1;
    const session = this.session;
    this.session = undefined;
    this.activeSessionId = undefined;
    this.failedSessionId = undefined;
    this.pending = [];
    this.leftover = new Int16Array();
    this.loggedSecondTalker = false;
    if (session !== undefined) await this.stopQuiet(session);
  }

  /**
   * Stop a session without letting a stop error escape.
   *
   * @param {TalkSession} session Session to stop
   * @returns {Promise<void>} Resolves when the stop has been attempted
   */
  private async stopQuiet(session: TalkSession): Promise<void> {
    try {
      await session.stop();
    } catch (error) {
      this.log.debug(`Talk stop failed for channel ${this.channel}: ${errorText(error)}`);
    }
  }
}
