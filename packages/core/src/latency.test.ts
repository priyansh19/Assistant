import { describe, expect, it } from 'vitest';
import { LatencyRecorder, percentile } from './latency.js';

describe('LatencyRecorder', () => {
  it('computes the plan §3.3 spans', () => {
    const r = new LatencyRecorder('i1', () => 0);
    r.mark('keyDown', 1000);
    r.mark('recordingStarted', 1030);
    r.mark('keyUp', 3000);
    r.mark('transcriptFinal', 3250);
    r.mark('firstToken', 3700);
    r.mark('firstPoint', 3710);
    r.mark('firstAudio', 4050);
    r.mark('done', 7000);
    expect(r.summary()).toEqual({
      interactionId: 'i1',
      recordingStartMs: 30,
      transcriptMs: 250,
      firstTokenMs: 450,
      tokenToAudioMs: 350,
      keyUpToFirstAudioMs: 1050,
      keyUpToPointMs: 710,
      totalMs: 6000,
    });
  });

  it('keeps the first occurrence and leaves missing spans null', () => {
    let t = 0;
    const r = new LatencyRecorder('i2', () => t);
    r.mark('keyUp');
    t = 100;
    r.mark('firstToken');
    t = 200;
    r.mark('firstToken');
    expect(r.get('firstToken')).toBe(100);
    expect(r.summary().keyUpToFirstAudioMs).toBeNull();
  });
});

describe('percentile', () => {
  it('uses nearest rank', () => {
    const v = [5, 1, 4, 2, 3];
    expect(percentile(v, 50)).toBe(3);
    expect(percentile(v, 95)).toBe(5);
    expect(percentile(v, 0)).toBe(1);
    expect(percentile([], 50)).toBeNull();
  });
});
