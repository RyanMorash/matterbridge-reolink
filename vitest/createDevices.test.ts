/**
 * @file vitest/createDevices.test.ts
 * @description Tests for Matter endpoint construction.
 * @author RyanMorash
 */

import { MatterbridgeEndpoint } from 'matterbridge';
import { Camera, FloodlightCamera, VideoDoorbell } from 'matterbridge/devices/camera';
import { CameraAvStreamManagement } from 'matterbridge/matter/clusters';

import { createChannelDevices, type ChannelDeviceInput } from '../src/createDevices.js';
import { resetTalkNotice, setMatterbridgeTalkSupport } from '../src/matterTalk.js';

function input(overrides: Partial<ChannelDeviceInput> = {}): ChannelDeviceInput {
  return {
    name: 'Porch',
    serial: 'SER123',
    channel: 0,
    vendorId: 0xfff1,
    productName: 'Reolink',
    softwareVersion: 1,
    softwareVersionString: '1.0.0',
    kind: 'camera',
    hasBattery: false,
    ptz: false,
    lightOn: false,
    sirenOn: false,
    extraLight: false,
    hasSiren: false,
    sensors: [],
    holdSeconds: 30,
    ...overrides,
  };
}

describe('createChannelDevices', () => {
  afterEach(() => {
    setMatterbridgeTalkSupport(undefined);
  });

  it('builds a camera, a doorbell, a floodlight, and sibling accessories', () => {
    const camera = createChannelDevices(
      input({ ptz: true, hasBattery: true, hasSiren: true, sirenOn: true, sensors: ['motion', 'person'], rtspUrl: 'rtsp://127.0.0.1:8554/stream' }),
    );
    expect(camera.primary).toBeInstanceOf(Camera);
    expect(camera.siren?.deviceName).toBe('Porch siren');
    expect(camera.sensors.size).toBe(2);
    expect(camera.doorbell).toBeUndefined();
    expect(camera.light).toBeUndefined();
    expect(createChannelDevices(input()).primary).toBeInstanceOf(Camera);

    const doorbell = createChannelDevices(input({ kind: 'doorbell', extraLight: true, lightOn: true, hasBattery: true }));
    expect(doorbell.primary).toBeInstanceOf(VideoDoorbell);
    expect(doorbell.doorbell?.id).toBe('Doorbell');
    expect(doorbell.light?.deviceName).toBe('Porch light');

    const floodlight = createChannelDevices(input({ kind: 'floodlight', lightOn: true }));
    expect(floodlight.primary).toBeInstanceOf(FloodlightCamera);
    expect(floodlight.light?.id).toBe('Light');
    expect(floodlight.siren).toBeUndefined();
  });

  it('omits children that the composed device did not create', () => {
    const child = vi.spyOn(MatterbridgeEndpoint.prototype, 'getChildEndpointById').mockImplementation((): undefined => {
      return;
    });
    const doorbell = createChannelDevices(input({ kind: 'doorbell' }));
    const floodlight = createChannelDevices(input({ kind: 'floodlight' }));
    expect(doorbell.doorbell).toBeUndefined();
    expect(floodlight.light).toBeUndefined();
    child.mockRestore();
  });

  it('adds speaker callbacks on the camera that owns WebRTC', () => {
    setMatterbridgeTalkSupport(true);
    const talk = {
      twoWayTalkSupport: CameraAvStreamManagement.TwoWayTalkSupportType.FullDuplex,
      onRemoteAudio: vi.fn(),
      onSessionClosed: vi.fn(),
    };
    const url = 'rtsp://127.0.0.1:8554/stream';
    const camera = createChannelDevices(input({ rtspUrl: url, talk }));
    const doorbell = createChannelDevices(input({ kind: 'doorbell', rtspUrl: url, talk }));
    const floodlight = createChannelDevices(input({ kind: 'floodlight', rtspUrl: url, talk }));
    const offers = [camera.primary, doorbell.primary.getChildEndpointById('Camera'), floodlight.primary.getChildEndpointById('Camera')].map(
      (endpoint) => endpoint?.getClusterServerOptions('WebRtcTransportProvider')?.weriftOfferOptions,
    );
    expect(offers[0]).toMatchObject({ acceptRemoteAudio: true, audioSourceDevice: url });
    expect(offers[1]).toMatchObject({ acceptRemoteAudio: true });
    expect(offers[2]).toMatchObject({ acceptRemoteAudio: true });
    const heard = { sessionId: 4, pcm: Int16Array.from([1]), sampleRate: 16000 };
    for (const offer of offers) {
      const callbacks = offer as { onRemoteAudio?: (frame: typeof heard) => void; onSessionClosed?: (sessionId: number) => void };
      callbacks.onRemoteAudio?.(heard);
      callbacks.onSessionClosed?.(4);
    }
    expect(talk.onRemoteAudio).toHaveBeenCalledTimes(3);
    expect(talk.onSessionClosed).toHaveBeenCalledTimes(3);
    resetTalkNotice();
  });
});
