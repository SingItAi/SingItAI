import { Readable, Writable } from "node:stream";
import { ServerResponse } from "node:http";

// Same socket-free Express harness used by error-codes.test.mjs.
export function request(app, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    Object.assign(req, { method, url: path, headers: { host: 'ask.test', ...headers }, httpVersionMajor: 1,
      httpVersionMinor: 1, httpVersion: '1.1', socket: { remoteAddress: '127.0.0.1' } });
    if (body !== undefined) req.headers['content-length'] = String(Buffer.byteLength(body));
    const res = new ServerResponse(req);
    const chunks = [];
    const socket = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    res.assignSocket(socket);
    res.on('error', reject);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks).toString();
      const text = raw.slice(raw.indexOf('\r\n\r\n') + 4);
      try { resolve({ status: res.statusCode, headers: res.getHeaders(), body: text ? JSON.parse(text) : null }); }
      catch (e) { reject(new Error(text, { cause: e })); }
    });
    app.handle(req, res);
  });
}
