import type { Page } from './accounts';

/** Inspect real private bytes without playing a second audible audio element.
 * Nonzero PCM is mechanical evidence only, never a human speech-quality score.
 */
export async function inspectGeneratedAudio(page: Page, mediaUrl: string) {
  return page.evaluate(async url => {
    if (new URL(url, location.origin).origin !== location.origin)
      throw new Error('Generated audio must use the authenticated same-origin endpoint.');
    const audio = new Audio();
    audio.preload = 'metadata';
    try {
      const metadata = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Audio metadata timeout')), 10_000);
        audio.onloadedmetadata = () => { clearTimeout(timeout); resolve(audio.duration * 1000); };
        audio.onerror = () => { clearTimeout(timeout); reject(new Error(`Audio metadata failed: ${audio.error?.code}`)); };
      });
      audio.src = url;
      const mediaDurationMs = await metadata;
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Private audio returned ${response.status}`);
      const encoded = await response.arrayBuffer();
      // decodeAudioData consumes/detaches its ArrayBuffer. Preserve the byte
      // count before decoding rather than mistaking a detached buffer for empty.
      const encodedBytes = encoded.byteLength;
      const context = new OfflineAudioContext(1, 1, 16000);
      const decoded = await context.decodeAudioData(encoded);
      const pcm = decoded.getChannelData(0);
      let energy = 0;
      let nonzeroSamples = 0;
      for (const sample of pcm) {
        energy += sample * sample;
        if (sample !== 0) nonzeroSamples++;
      }
      return {
        contentType: response.headers.get('Content-Type')?.split(';')[0],
        encodedBytes,
        mediaDurationMs,
        decodedDurationMs: decoded.duration * 1000,
        decodedFrames: decoded.length,
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        rms: Math.sqrt(energy / pcm.length),
        nonzeroSamples,
      };
    } finally {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
  }, mediaUrl);
}
