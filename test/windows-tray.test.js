import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startWindowsTray } from '../runtime/tray-supervisor.js';

test('tray failures restart without affecting the studio and stop cancels restart', () => {
  const launched = [];
  const logs = [];
  let scheduled;
  let cancelled = false;
  const tray = startWindowsTray({
    port: 5173,
    ownerPid: 123,
    env: { SystemRoot: 'C:\\Windows' },
    log: (message) => logs.push(message),
    launch: (executable, args, options) => {
      const child = new EventEmitter();
      child.unref = () => {};
      launched.push({ executable, args, options, child });
      return child;
    },
    scheduleTimer: (callback, delay) => {
      scheduled = { callback, delay, unref() {} };
      return scheduled;
    },
    cancelTimer: (handle) => {
      cancelled = handle === scheduled;
    },
  });
  assert.equal(launched.length, 1);
  assert.equal(launched[0].options.windowsHide, true);
  assert.deepEqual(launched[0].args.slice(-4), ['-Port', '5173', '-OwnerPid', '123']);
  launched[0].child.emit('error', Error('test failure'));
  launched[0].child.emit('exit', 1);
  assert.equal(scheduled.delay, 5000);
  assert.equal(logs.filter((line) => line.includes('tray_stopped')).length, 1);
  scheduled.callback();
  assert.equal(launched.length, 2);
  launched[1].child.emit('exit', 1);
  assert.equal(scheduled.delay, 10000);
  tray.stop();
  assert.equal(cancelled, true);
  scheduled.callback();
  assert.equal(launched.length, 2);
});

test(
  'Windows queue notification transitions ignore history and handle quick and failed jobs',
  { skip: process.platform !== 'win32' },
  () => {
    const script = fileURLToPath(new URL('../runtime/windows-tray.ps1', import.meta.url));
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-Port',
        '5173',
        '-OwnerPid',
        String(process.pid),
        '-TestQueueEvents',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /transitions passed/);
  },
);

test(
  'Windows notification shortcut can be reopened and refuses to overwrite a different shortcut',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-tray-link-test-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const helper = fileURLToPath(new URL('../runtime/windows-toast.cs', import.meta.url));
    const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -Path $env:FORGE_TEST_TOAST_HELPER
    $exe = Join-Path $PSHOME 'powershell.exe'
    [ForgeToastShortcut]::Ensure($env:FORGE_TEST_TOAST_LINK, $exe, '-NoProfile', $env:FORGE_TEST_TOAST_DIR, $exe)
    [ForgeToastShortcut]::Ensure($env:FORGE_TEST_TOAST_LINK, $exe, '-NoProfile', $env:FORGE_TEST_TOAST_DIR, $exe)
    try {
      [ForgeToastShortcut]::Ensure($env:FORGE_TEST_TOAST_LINK, $exe, '-Different', $env:FORGE_TEST_TOAST_DIR, $exe)
      exit 4
    } catch { exit 0 }
  `;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      env: {
        ...process.env,
        FORGE_TEST_TOAST_HELPER: helper,
        FORGE_TEST_TOAST_LINK: path.join(root, 'test.lnk'),
        FORGE_TEST_TOAST_DIR: root,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok((await fs.stat(path.join(root, 'test.lnk'))).isFile());
  },
);
