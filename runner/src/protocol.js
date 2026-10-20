'use strict';
// Wire formats shared by the runner and its tests:
//  - the kernel's line protocol (see kernel/src/lp/Kernel.java)
//  - Docker's multiplexed attach stream (8-byte frame headers when the container has no TTY)

const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');

const nonceLine = (nonce) => `NONCE ${nonce}\n`;
const cellLine = (id, source) => `CELL ${id} ${b64(source)}\n`;
const fileLine = (kind, path, content) => `${kind} ${b64(path)} ${b64(content)}\n`;

/**
 * Splits Docker's multiplexed stream into stdout/stderr chunks.
 * Frame: [stream(1) 0 0 0 size(4, big-endian)] then `size` bytes. stream 1 = stdout, 2 = stderr.
 */
class DockerDemuxer {
  constructor(onStdout, onStderr) {
    this.buffer = Buffer.alloc(0);
    this.onStdout = onStdout;
    this.onStderr = onStderr;
  }

  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 8) {
      const type = this.buffer[0];
      const size = this.buffer.readUInt32BE(4);
      if (this.buffer.length < 8 + size) return;
      const payload = this.buffer.subarray(8, 8 + size);
      this.buffer = this.buffer.subarray(8 + size);
      if (type === 2) this.onStderr(payload);
      else this.onStdout(payload);
    }
  }
}

/**
 * Collects kernel messages from stdout. Only lines that start with the record separator, "LP"
 * and this run's nonce count; anything else student code prints to the real stdout is ignored.
 */
class KernelReader {
  constructor(nonce, onMessage, { maxLine = 4 * 1024 * 1024 } = {}) {
    this.prefix = `\u001eLP ${nonce} `;
    this.onMessage = onMessage;
    this.maxLine = maxLine;
    this.pending = '';
    this.decoder = new (require('string_decoder').StringDecoder)('utf8');
  }

  push(chunk) {
    this.pending += this.decoder.write(chunk);
    let nl;
    while ((nl = this.pending.indexOf('\n')) !== -1) {
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 1);
      this.line(line);
    }
    // A runaway line without a newline is dropped rather than buffered forever
    if (this.pending.length > this.maxLine) this.pending = '';
  }

  line(line) {
    if (!line.startsWith(this.prefix)) return;
    try {
      this.onMessage(JSON.parse(line.slice(this.prefix.length)));
    } catch {
      // a truncated or forged line is not a message
    }
  }
}

module.exports = { b64, nonceLine, cellLine, fileLine, DockerDemuxer, KernelReader };
