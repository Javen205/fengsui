import type { AddressInfo } from 'node:net';

import { SMTPServer } from 'smtp-server';

export interface CapturedMessage {
  raw: string;
  mailFrom: string;
  rcptTo: string[];
}

export interface TestSmtpOptions {
  rejectAuth?: boolean;
  rejectRcptCode?: number;
  rejectRcptMessage?: string;
}

export interface TestSmtpServer {
  port: number;
  messages: CapturedMessage[];
  options: TestSmtpOptions;
  close(): Promise<void>;
}

function smtpError(message: string, responseCode: number): Error {
  return Object.assign(new Error(message), { responseCode });
}

export async function startTestSmtpServer(
  initialOptions: TestSmtpOptions = {},
): Promise<TestSmtpServer> {
  const messages: CapturedMessage[] = [];
  const options: TestSmtpOptions = { ...initialOptions };

  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onAuth(auth, _session, callback) {
      if (options.rejectAuth === true) {
        callback(smtpError('535 Invalid username or password', 535));
        return;
      }
      callback(null, { user: auth.username ?? 'test-user' });
    },
    onRcptTo(address, _session, callback) {
      if (options.rejectRcptCode !== undefined) {
        callback(
          smtpError(
            options.rejectRcptMessage ?? 'Requested action aborted',
            options.rejectRcptCode,
          ),
        );
        return;
      }
      callback();
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      stream.on('error', (error) => {
        callback(error);
      });
      stream.on('end', () => {
        messages.push({
          raw: Buffer.concat(chunks).toString('utf8'),
          mailFrom: session.envelope.mailFrom !== false ? session.envelope.mailFrom.address : '',
          rcptTo: session.envelope.rcptTo.map((address) => address.address),
        });
        callback();
      });
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
    server.once('error', reject);
  });

  const address = server.server.address() as AddressInfo;

  return {
    port: address.port,
    messages,
    options,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
