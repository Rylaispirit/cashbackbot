import 'dotenv/config';
import * as https from 'https';

interface TelegramCommand {
  command: string;
  description: string;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

const COMMANDS: TelegramCommand[] = [
  { command: 'start', description: 'Bat dau / xem huong dan' },
  { command: 'balance', description: 'Xem so du cashback' },
  { command: 'history', description: 'Lich su giao dich' },
  { command: 'setbank', description: 'Cai tai khoan nhan tien' },
  { command: 'withdraw', description: 'Yeu cau rut tien' },
  { command: 'help', description: 'Xem lai huong dan' },
  { command: 'cancel', description: 'Huy thao tac dang lam' },
];

function postJson<T>(path: string, body: object, token: string): Promise<TelegramApiResponse<T>> {
  const data = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}${path}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 20_000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(raw) as TelegramApiResponse<T>);
          } catch {
            reject(new Error(`Telegram returned non-JSON response: ${raw.slice(0, 300)}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('Telegram request timed out')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is missing');
  }

  const setRes = await postJson<boolean>('/setMyCommands', { commands: COMMANDS }, token);
  if (!setRes.ok || !setRes.result) {
    throw new Error(`setMyCommands failed: ${setRes.description ?? 'unknown error'}`);
  }

  const getRes = await postJson<TelegramCommand[]>('/getMyCommands', {}, token);
  if (!getRes.ok || !getRes.result) {
    throw new Error(`getMyCommands failed: ${getRes.description ?? 'unknown error'}`);
  }

  console.log('Telegram public command menu updated:');
  for (const cmd of getRes.result) {
    console.log(`/${cmd.command} - ${cmd.description}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
