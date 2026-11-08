import { spawn } from 'node:child_process';
import fs from 'node:fs';

export async function run(job) {
  try {
    fs.unlinkSync(job.temp);
  } catch {}
  const response = await fetch('https://example.invalid/model');
  job.status = 'running';
  const child = spawn('worker.exe', []);
  try {
    await response.json();
  } catch (error) {
    return null;
  }
  try {
    child.kill();
  } catch (error) {
    throw error;
  }
  refresh().then(() => {});
  return child;
}
