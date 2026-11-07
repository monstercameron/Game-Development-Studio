import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
  stdio: 'ignore',
  windowsHide: true,
});
console.log(JSON.stringify({ childPid: child.pid }));
setInterval(() => {}, 1000);
