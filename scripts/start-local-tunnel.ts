import 'dotenv/config';

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function printHelp() {
  console.log(`
Run ChotDeal locally with a Cloudflare Tunnel.

Usage:
  npm run start:tunnel
  npm run start:tunnel -- --skip-build
  npm run start:tunnel -- --port=3000

Notes:
  - Telegram runs in polling mode locally.
  - Accesstrade postback should use the Cloudflare URL printed by this script.
  - Install cloudflared first: winget install --id Cloudflare.cloudflared
`);
}

async function main() {
  if (hasFlag('help') || hasFlag('h')) {
    printHelp();
    return;
  }

  const cwd = process.cwd();
  const port = argValue('port') ?? process.env.PORT ?? '3000';
  const targetUrl = `http://localhost:${port}`;
  const skipBuild = hasFlag('skip-build');
  const distMain = resolve(cwd, 'dist/main.js');
  const runtimeDir = resolve(cwd, '.runtime');
  const publicUrlFile = resolve(runtimeDir, 'public-base-url.txt');
  const children: ChildProcess[] = [];
  let shuttingDown = false;

  function stopAll(exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (!child.killed) child.kill('SIGTERM');
    }
    rmSync(publicUrlFile, { force: true });
    setTimeout(() => process.exit(exitCode), 500).unref();
  }

  function attachExit(child: ChildProcess, name: string) {
    child.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        console.error(`\n${name} not found.`);
        if (name === 'cloudflared') {
          console.error('Install it with: winget install --id Cloudflare.cloudflared');
        }
      } else {
        console.error(`\n${name} failed: ${(err as Error).message}`);
      }
      stopAll(1);
    });

    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      console.error(`\n${name} exited code=${code ?? '-'} signal=${signal ?? '-'}`);
      stopAll(code ?? 1);
    });
  }

  rmSync(publicUrlFile, { force: true });

  process.on('SIGINT', () => stopAll(0));
  process.on('SIGTERM', () => stopAll(0));

  if (!skipBuild || !existsSync(distMain)) {
    console.log('Building Nest app...');
    await new Promise<void>((resolveBuild, rejectBuild) => {
      const build = spawn(npmCommand(), ['run', 'build'], {
        cwd,
        stdio: 'inherit',
        shell: false,
      });
      build.on('error', rejectBuild);
      build.on('exit', (code) => {
        if (code === 0) resolveBuild();
        else rejectBuild(new Error(`npm run build exited with code ${code}`));
      });
    });
  }

  console.log(`Starting bot locally on ${targetUrl}...`);
  const bot = spawn(process.execPath, [distMain], {
    cwd,
    env: {
      ...process.env,
      PORT: port,
      TELEGRAM_UPDATES_MODE: 'polling',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  children.push(bot);
  attachExit(bot, 'bot');
  bot.stdout?.on('data', (chunk) => process.stdout.write(`[bot] ${chunk}`));
  bot.stderr?.on('data', (chunk) => process.stderr.write(`[bot] ${chunk}`));

  console.log(`Starting Cloudflare Tunnel to ${targetUrl}...`);
  const tunnel = spawn('cloudflared', ['tunnel', '--url', targetUrl], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  children.push(tunnel);
  attachExit(tunnel, 'cloudflared');

  let printedUrl = false;
  function handleTunnelOutput(chunk: Buffer) {
    const text = chunk.toString();
    process.stdout.write(`[tunnel] ${text}`);
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (!match || printedUrl) return;

    printedUrl = true;
    const publicUrl = match[0].replace(/\/$/, '');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(publicUrlFile, `${publicUrl}\n`, 'utf8');
    console.log('\nCloudflare Tunnel is ready.');
    console.log(`Public URL: ${publicUrl}`);
    console.log(`Accesstrade postback URL: ${publicUrl}/api/postback/accesstrade`);
    console.log('Telegram stays in polling mode locally, so no webhook change is needed.');
    console.log('Press Ctrl+C to stop bot + tunnel.\n');
  }

  tunnel.stdout?.on('data', handleTunnelOutput);
  tunnel.stderr?.on('data', handleTunnelOutput);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
