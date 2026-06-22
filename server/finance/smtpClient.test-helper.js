// Shared helper for tests that need a mock SMTP server.
// Extracted from smtpClient.test.js so that emailService.test.js
// can also spin up a local SMTP server without duplicating
// the mock state machine.

import net from 'node:net';

/**
 * Start a mock SMTP server on an OS-assigned port.
 * Returns a handle with .port, .commands, .dataBuffer(),
 * and .close().
 *
 * @param {object} [opts]
 * @param {string} [opts.banner] — server greeting (default 220)
 * @param {string} [opts.starttlsResponse] — STARTTLS response (null = 454)
 * @param {string} [opts.authResponse] — AUTH PLAIN response (null = 535)
 * @param {string} [opts.mailFromResponse] — MAIL FROM response
 * @param {string} [opts.rcptToResponse] — RCPT TO response
 * @param {string} [opts.dataResponse] — DATA response (defaults to 354 + 250)
 * @param {string} [opts.finalDataResponse] — post-DATA response
 * @param {string} [opts.quitResponse] — QUIT response
 */
export function startMockSmtpServer(opts = {}) {
  const commands = [];
  let dataBufferValue = '';
  const banner = opts.banner ?? null;
  const starttlsResponse = opts.starttlsResponse ?? null;
  const authResponse = opts.authResponse ?? '235 OK\r\n';
  const mailFromResponse = opts.mailFromResponse ?? '250 OK\r\n';
  const rcptToResponse = opts.rcptToResponse ?? '250 OK\r\n';
  const finalDataResponse = opts.finalDataResponse ?? '250 OK\r\n';
  const quitResponse = opts.quitResponse ?? '221 Bye\r\n';

  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = '';
      let dataMode = false;
      let dataBuffer = '';

      function write(line) {
        socket.write(line);
      }

      function respond(code, message) {
        write(`${code} ${message}\r\n`);
      }

      // Send the greeting IMMEDIATELY on connection (not on
      // the first data event). SMTP servers send the 220
      // greeting right after accept; the client expects it
      // before sending EHLO.
      if (banner) {
        write(`${banner}\r\n`);
      } else {
        write('220 sbos-mock.local ready\r\n');
      }

      function handleCommand(line) {
        commands.push(line);
        const upper = line.toUpperCase();
        if (dataMode) {
          if (line === '.') {
            dataMode = false;
            dataBufferValue = dataBuffer;
            respond(250, finalDataResponse.replace(/^\d+\s/, ''));
          } else {
            dataBuffer += `${line}\n`;
          }
          return;
        }
        if (upper.startsWith('EHLO')) {
          const caps = ['PIPELINING', '8BITMIME', 'AUTH PLAIN LOGIN'];
          write('250-sbos-mock.local\r\n');
          for (let i = 0; i < caps.length - 1; i += 1) {
            write(`250-${caps[i]}\r\n`);
          }
          write(`250 ${caps[caps.length - 1]}\r\n`);
        } else if (upper.startsWith('HELO')) {
          write('250 OK\r\n');
        } else if (upper === 'STARTTLS') {
          if (starttlsResponse) {
            write(`${starttlsResponse}\r\n`);
          } else {
            respond(454, 'TLS not available');
          }
        } else if (upper.startsWith('AUTH PLAIN')) {
          if (authResponse) {
            write(`${authResponse}\r\n`);
          } else {
            respond(535, 'auth failed');
          }
        } else if (upper.startsWith('MAIL FROM')) {
          write(`${mailFromResponse}\r\n`);
        } else if (upper.startsWith('RCPT TO')) {
          write(`${rcptToResponse}\r\n`);
        } else if (upper === 'DATA') {
          dataMode = true;
          dataBuffer = '';
          respond(354, 'go ahead');
        } else if (upper === 'QUIT') {
          write(`${quitResponse}\r\n`);
          socket.end();
        } else if (upper === 'NOOP') {
          respond(250, 'OK');
        } else if (upper === 'RSET') {
          respond(250, 'OK');
        } else {
          respond(500, 'unrecognized');
        }
      }

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (dataMode) {
          const lines = buffer.split('\r\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            handleCommand(line);
          }
        } else {
          const lines = buffer.split('\r\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.length === 0) continue;
            handleCommand(line);
          }
        }
      });

      socket.on('error', () => { /* ignore */ });
      socket.on('end', () => { /* ignore */ });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        commands,
        dataBuffer: () => dataBufferValue,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
