/**
 * @file vitest/talk.test.ts
 * @description Tests for Reolink talk ability, resampling, and the talk bridge.
 * @author RyanMorash
 */

import type { Logger, TalkAbility, TalkSession } from '@apocaliss92/nodelink-js';
import type { AnsiLogger } from 'matterbridge/logger';
import { CameraAvStreamManagement } from 'matterbridge/matter/clusters';

import {
  attachTalk,
  cameraTalkFields,
  matterbridgeAcceptsTalk,
  noteTalkUnavailable,
  resetTalkNotice,
  setMatterbridgeTalkSupport,
  SPEAKER_CAPABILITIES,
  type RemoteAudioFrame,
} from '../src/matterTalk.js';
import { clampPcmSample, isRemoteAudioFrame, resampleMono, TalkBridge, talkSupportFromAbility, TALK_IDLE_MS, type TalkOpener } from '../src/talk.js';

const HalfDuplex = CameraAvStreamManagement.TwoWayTalkSupportType.HalfDuplex;
const FullDuplex = CameraAvStreamManagement.TwoWayTalkSupportType.FullDuplex;

function log(): AnsiLogger {
  return { fatal: vi.fn(), error: vi.fn(), warn: vi.fn(), notice: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn() } as unknown as AnsiLogger;
}

function ability(audioType: string, duplex: string[]): TalkAbility {
  return {
    duplexList: duplex,
    audioStreamModeList: [],
    audioConfigList: [{ audioType, sampleRate: 16000, samplePrecision: 16, lengthPerEncoder: 8, soundTrack: 'mono' }],
  };
}

function frame(sessionId: number, values: number[], sampleRate = 16000): RemoteAudioFrame {
  return { sessionId, pcm: Int16Array.from(values), sampleRate };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let finish: (value: T) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  return { promise, resolve: finish, reject: fail };
}

describe('talk helpers', () => {
  afterEach(() => {
    setMatterbridgeTalkSupport(undefined);
    resetTalkNotice();
  });

  it('clamps samples and resamples mono PCM', () => {
    expect(clampPcmSample(Number.NaN)).toBe(0);
    expect(clampPcmSample(40000.2)).toBe(32767);
    expect(clampPcmSample(-40000.2)).toBe(-32768);
    expect(clampPcmSample(1.4)).toBe(1);
    expect(resampleMono(Int16Array.from([]), 16000, 8000)).toEqual(new Int16Array());
    expect(resampleMono(Int16Array.from([1, 2]), Number.NaN, 8000)).toEqual(new Int16Array());
    expect(resampleMono(Int16Array.from([1, 2]), 16000, Number.POSITIVE_INFINITY)).toEqual(new Int16Array());
    expect(resampleMono(Int16Array.from([1, 2]), 0, 8000)).toEqual(new Int16Array());
    expect(resampleMono(Int16Array.from([1, 2]), 16000, -1)).toEqual(new Int16Array());
    const same = resampleMono(Int16Array.from([3, 4]), 8000, 8000);
    expect(same).toEqual(Int16Array.from([3, 4]));
    expect(same).not.toBe(Int16Array.from([3, 4]));
    expect(resampleMono(Int16Array.from([0, 300]), 2, 4).length).toBe(4);
    expect(resampleMono(Int16Array.from([9]), 100, 10)).toEqual(Int16Array.from([9]));
  });

  it('maps ADPCM talk ability to half or full duplex', () => {
    expect(talkSupportFromAbility({ audioConfigList: undefined as unknown as TalkAbility['audioConfigList'], duplexList: [], audioStreamModeList: [] })).toBeUndefined();
    expect(talkSupportFromAbility(ability('aac', ['full']))).toBeUndefined();
    expect(talkSupportFromAbility(ability(' ADPCM ', []))).toBe(HalfDuplex);
    expect(talkSupportFromAbility({ ...ability('adpcm', []), duplexList: undefined as unknown as string[] })).toBe(HalfDuplex);
    expect(talkSupportFromAbility(ability('adpcm', ['half']))).toBe(HalfDuplex);
    expect(talkSupportFromAbility(ability('adpcm', [' FDX ']))).toBe(FullDuplex);
    expect(isRemoteAudioFrame(frame(0, [1]))).toBe(true);
    expect(isRemoteAudioFrame(frame(1.5, [1]))).toBe(false);
    expect(isRemoteAudioFrame(frame(-1, [1]))).toBe(false);
    expect(isRemoteAudioFrame({ sessionId: 1, pcm: [1, 2] as unknown as Int16Array, sampleRate: 8000 })).toBe(false);
    expect(isRemoteAudioFrame(frame(1, []))).toBe(false);
    expect(isRemoteAudioFrame(frame(1, [1], 0))).toBe(false);
  });

  it('keeps talk options off until Matterbridge accepts remote audio', () => {
    const platform = log();
    expect(matterbridgeAcceptsTalk()).toBe(false);
    const offer = { audioSource: 'rtsp' as const };
    const hooks = { twoWayTalkSupport: HalfDuplex, onRemoteAudio: vi.fn(), onSessionClosed: vi.fn() };
    expect(attachTalk(offer)).toBe(offer);
    expect(attachTalk(offer, hooks)).toEqual({ audioSource: 'rtsp' });
    expect(cameraTalkFields()).toEqual({});
    expect(cameraTalkFields(hooks)).toEqual({});
    noteTalkUnavailable(platform);
    noteTalkUnavailable(platform);
    expect(platform.info).toHaveBeenCalledTimes(1);
    resetTalkNotice();
    noteTalkUnavailable(platform);
    expect(platform.info).toHaveBeenCalledTimes(2);

    setMatterbridgeTalkSupport(true);
    expect(matterbridgeAcceptsTalk()).toBe(true);
    const attached = attachTalk(offer, hooks) as typeof offer & {
      acceptRemoteAudio: boolean;
      onRemoteAudio: (frame: RemoteAudioFrame) => void;
      onSessionClosed: (sessionId: number) => void;
    };
    const heard = frame(3, [4]);
    attached.onRemoteAudio(heard);
    attached.onSessionClosed(3);
    expect(attached.acceptRemoteAudio).toBe(true);
    expect(hooks.onRemoteAudio).toHaveBeenCalledWith(heard);
    expect(hooks.onSessionClosed).toHaveBeenCalledWith(3);
    expect(cameraTalkFields(hooks)).toEqual({ twoWayTalkSupport: HalfDuplex, speakerCapabilities: SPEAKER_CAPABILITIES });
    setMatterbridgeTalkSupport(false);
    expect(matterbridgeAcceptsTalk()).toBe(false);
    expect(cameraTalkFields(hooks)).toEqual({});
  });
});

describe('TalkBridge', () => {
  const platform = log();

  function bridge(open: TalkOpener, reolinkLogger?: Logger): TalkBridge {
    return new TalkBridge(2, 'reolink-SER-ch2', open, platform, reolinkLogger);
  }

  function session(sampleRate = 16000, blockSize = 1): TalkSession & { sendAudio: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
    return {
      info: {
        channel: 2,
        blockSize,
        fullBlockSize: blockSize + 4,
        audioConfig: { audioType: 'adpcm', sampleRate, samplePrecision: 16, lengthPerEncoder: blockSize * 2, soundTrack: 'mono' },
      },
      sendAudio: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('encodes whole blocks, keeps a partial block, and ignores a second talker', async () => {
    const opened = session();
    const open = vi.fn(async () => opened);
    const talk = bridge(open, { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
    talk.onRemoteAudio(frame(1.2, [1]));
    talk.onRemoteAudio(frame(4, [1, 2], 0));
    expect(open).not.toHaveBeenCalled();
    talk.onRemoteAudio(frame(4, [1, 2], 32000));
    talk.onRemoteAudio(frame(4, [10, 20, 30], 16000));
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        2,
        expect.objectContaining({ idleTimeoutMs: TALK_IDLE_MS, deviceId: 'reolink-SER-ch2', logger: expect.objectContaining({ debug: expect.any(Function) }) }),
      ),
    );
    await vi.waitFor(() => expect(opened.sendAudio).toHaveBeenCalledTimes(1));
    expect(opened.sendAudio.mock.calls[0]?.[0]).toBeInstanceOf(Buffer);
    talk.onRemoteAudio(frame(9, [1, 2, 3]));
    talk.onRemoteAudio(frame(9, [4, 5, 6]));
    expect(platform.info).toHaveBeenCalledTimes(1);
    expect(opened.sendAudio).toHaveBeenCalledTimes(1);
    talk.onSessionClosed(3);
    expect(opened.stop).not.toHaveBeenCalled();
    talk.onRemoteAudio(frame(4, [7, 8, 9]));
    await vi.waitFor(() => expect(opened.sendAudio).toHaveBeenCalledTimes(2));
    talk.onSessionClosed(4);
    await vi.waitFor(() => expect(opened.stop).toHaveBeenCalledTimes(1));
    await talk.shutdown();
  });

  it('drops audio from a failed open and allows a later session', async () => {
    const open = vi.fn<TalkOpener>();
    open.mockRejectedValueOnce(new Error('busy'));
    const opened = session();
    open.mockResolvedValueOnce(opened);
    const talk = bridge(open);
    talk.onRemoteAudio(frame(1, [1, 2, 3]));
    await vi.waitFor(() => expect(platform.error).toHaveBeenCalledWith(expect.stringContaining('Talk session failed')));
    talk.onRemoteAudio(frame(1, [4, 5, 6]));
    expect(open).toHaveBeenCalledTimes(1);
    talk.onRemoteAudio(frame(2, [7, 8, 9]));
    await vi.waitFor(() => expect(opened.sendAudio).toHaveBeenCalledTimes(1));
    await talk.shutdown();
  });

  it('stops a socket that reports an unusable format', async () => {
    const badRate = session(0, 1);
    const badBlock = session(16000, 0);
    const fractional = session(16000, 1.5);
    const open = vi.fn<TalkOpener>();
    open.mockResolvedValueOnce(badRate).mockResolvedValueOnce(badBlock).mockResolvedValueOnce(fractional);
    const talk = bridge(open);
    talk.onRemoteAudio(frame(1, [1]));
    await vi.waitFor(() => expect(badRate.stop).toHaveBeenCalled());
    talk.onSessionClosed(1);
    talk.onRemoteAudio(frame(2, [1]));
    await vi.waitFor(() => expect(badBlock.stop).toHaveBeenCalled());
    talk.onSessionClosed(2);
    talk.onRemoteAudio(frame(3, [1]));
    await vi.waitFor(() => expect(fractional.stop).toHaveBeenCalled());
    expect(platform.error).toHaveBeenCalledWith(expect.stringContaining('unusable audio format'));
    await talk.shutdown();
  });

  it('stops when a send fails and ignores a send that loses the race with close', async () => {
    const failing = session();
    failing.sendAudio.mockRejectedValueOnce(new Error('reset'));
    const open = vi.fn(async () => failing);
    const talk = bridge(open);
    talk.onRemoteAudio(frame(1, [1, 2, 3]));
    await vi.waitFor(() => expect(failing.stop).toHaveBeenCalled());
    expect(platform.error).toHaveBeenCalledWith(expect.stringContaining('Talk audio failed'));

    let rejectSend: (error: unknown) => void = () => {};
    const pendingSend = new Promise<void>((_resolve, reject) => {
      rejectSend = reject;
    });
    const racing = session();
    racing.sendAudio.mockReturnValueOnce(pendingSend);
    const second = bridge(async () => racing);
    second.onRemoteAudio(frame(5, [4, 5, 6]));
    await vi.waitFor(() => expect(racing.sendAudio).toHaveBeenCalled());
    const closing = second.shutdown();
    rejectSend(new Error('closed'));
    await closing;
    expect(racing.stop).toHaveBeenCalled();

    const queued = session();
    const held = deferred<boolean>();
    queued.sendAudio.mockReturnValueOnce(held.promise.then(() => true));
    const third = bridge(async () => queued);
    third.onRemoteAudio(frame(1, [1, 2, 3]));
    third.onRemoteAudio(frame(1, [4, 5, 6]));
    await vi.waitFor(() => expect(queued.sendAudio).toHaveBeenCalledTimes(1));
    const stopping = third.shutdown();
    held.resolve(true);
    await stopping;
    expect(queued.sendAudio).toHaveBeenCalledTimes(1);
  });

  it('discards an open that finishes after shutdown and logs a stop error', async () => {
    const late = deferred<TalkSession>();
    const open = vi.fn(async () => late.promise);
    const talk = bridge(open);
    talk.onRemoteAudio(frame(1, [1, 2, 3]));
    const stopping = talk.shutdown();
    late.reject(new Error('too late'));
    await stopping;
    expect(platform.error).not.toHaveBeenCalled();

    const opened = session();
    opened.stop.mockRejectedValueOnce(new Error('already closed'));
    const slow = deferred<TalkSession>();
    const second = bridge(async () => slow.promise);
    second.onRemoteAudio(frame(8, [1]));
    const shutdown = second.shutdown();
    slow.resolve(opened);
    await shutdown;
    expect(opened.stop).toHaveBeenCalled();
    expect(platform.debug).toHaveBeenCalledWith(expect.stringContaining('Talk stop failed'));
    await second.shutdown();
  });

  it('joins a second shutdown while the first stop is still running', async () => {
    const opened = session();
    const gate = deferred<boolean>();
    opened.stop.mockReturnValueOnce(gate.promise);
    const talk = bridge(async () => opened);
    talk.onRemoteAudio(frame(1, [1, 2, 3]));
    await vi.waitFor(() => expect(opened.sendAudio).toHaveBeenCalled());
    const first = talk.shutdown();
    const second = talk.shutdown();
    gate.resolve(true);
    await Promise.all([first, second]);
    expect(opened.stop).toHaveBeenCalledTimes(1);
    talk.onRemoteAudio(frame(1, [1, 2, 3]));
    expect(opened.sendAudio).toHaveBeenCalledTimes(1);
  });

  it('keeps a later talker when the failed session closes', async () => {
    const open = vi.fn<TalkOpener>();
    open.mockRejectedValueOnce(new Error('busy'));
    const opened = session();
    open.mockResolvedValueOnce(opened);
    const talk = bridge(open);
    talk.onRemoteAudio(frame(1, [1, 2, 3]));
    await vi.waitFor(() => expect(platform.error).toHaveBeenCalledWith(expect.stringContaining('Talk session failed')));
    talk.onRemoteAudio(frame(2, [4, 5, 6]));
    await vi.waitFor(() => expect(opened.sendAudio).toHaveBeenCalledTimes(1));
    talk.onSessionClosed(1);
    expect(opened.stop).not.toHaveBeenCalled();
    talk.onRemoteAudio(frame(2, [7, 8, 9]));
    await vi.waitFor(() => expect(opened.sendAudio).toHaveBeenCalledTimes(2));
    talk.onSessionClosed(2);
    await vi.waitFor(() => expect(opened.stop).toHaveBeenCalledTimes(1));
  });

  it('stops a talker that starts while the previous socket is still closing', async () => {
    const first = session();
    const stopGate = deferred<boolean>();
    first.stop.mockReturnValueOnce(stopGate.promise);
    const second = session();
    const open = vi.fn<TalkOpener>();
    open.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const talk = bridge(open);
    talk.onRemoteAudio(frame(1, [1, 2, 3]));
    await vi.waitFor(() => expect(first.sendAudio).toHaveBeenCalled());
    talk.onSessionClosed(1);
    await vi.waitFor(() => expect(first.stop).toHaveBeenCalled());
    talk.onRemoteAudio(frame(2, [4, 5, 6]));
    await vi.waitFor(() => expect(second.sendAudio).toHaveBeenCalled());
    talk.onSessionClosed(2);
    stopGate.resolve(true);
    await vi.waitFor(() => expect(second.stop).toHaveBeenCalled());
  });

  it('drops audio while the RTSP proxy is down', async () => {
    const opened = session();
    const open = vi.fn(async () => opened);
    const talk = bridge(open);
    talk.setStreamReady(false);
    talk.onRemoteAudio(frame(1, [1, 2, 3]));
    expect(open).not.toHaveBeenCalled();
    talk.setStreamReady(true);
    talk.onRemoteAudio(frame(1, [1, 2, 3]));
    await vi.waitFor(() => expect(opened.sendAudio).toHaveBeenCalled());
  });
});
