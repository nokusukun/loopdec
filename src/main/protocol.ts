import { protocol } from 'electron';
import fs from 'node:fs';
import { clipPath } from './paths';

export function registerClipProtocolSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'clip', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } },
  ]);
}

export function handleClipProtocol(): void {
  protocol.handle('clip', (request) => {
    const id = decodeURIComponent(request.url.slice('clip:///'.length));
    const filePath = clipPath(id);

    let stat: fs.Stats;
    try { stat = fs.statSync(filePath); }
    catch { return new Response('Not found', { status: 404 }); }

    const fileSize = stat.size;
    const rangeHeader = request.headers.get('Range');

    if (rangeHeader) {
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (!match) return new Response('Bad range', { status: 416 });
      const start = parseInt(match[1], 10);
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      return new Response(fs.createReadStream(filePath, { start, end }) as unknown as ReadableStream, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
          'Content-Type': 'video/mp4',
        },
      });
    }

    return new Response(fs.createReadStream(filePath) as unknown as ReadableStream, {
      status: 200,
      headers: {
        'Content-Length': String(fileSize),
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
      },
    });
  });
}
