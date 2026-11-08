// Stand-in for the `gh` and `git` executables in error-issue tests. It never contacts GitHub.
// Behaviour comes from scenario.json next to the log file named in argv[2]; every call is
// appended to calls.jsonl, including the contents of any --body-file at the time of the call.
import fs from 'node:fs';
import path from 'node:path';

const [stateDirectory, tool, ...args] = process.argv.slice(2);
const scenario = JSON.parse(fs.readFileSync(path.join(stateDirectory, 'scenario.json'), 'utf8'));
const bodyFileIndex = args.indexOf('--body-file');
const bodyFile = bodyFileIndex >= 0 ? args[bodyFileIndex + 1] : null;
fs.appendFileSync(
  path.join(stateDirectory, 'calls.jsonl'),
  `${JSON.stringify({
    tool,
    args,
    body: bodyFile && fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : null,
  })}\n`,
);
const command = args.slice(0, 2).join(' ');
if (tool === 'git') {
  process.stdout.write(`${scenario.remote}\n`);
} else if (command === 'auth status') {
  if (scenario.unauthenticated) {
    process.stderr.write(
      'You are not logged into any GitHub hosts. To log in, run: gh auth login\n',
    );
    process.exit(1);
  }
} else if (command === 'issue list') {
  process.stdout.write(JSON.stringify(scenario.duplicates || []));
} else if (command === 'label list') {
  process.stdout.write(JSON.stringify((scenario.labels || []).map((name) => ({ name }))));
} else if (command === 'issue create') {
  process.stdout.write('Creating issue\nhttps://github.com/owner/forge/issues/42\n');
} else if (command === 'issue comment') {
  process.stdout.write(`https://github.com/owner/forge/issues/${args[2]}#issuecomment-7\n`);
} else {
  process.stderr.write(`unexpected command ${command}\n`);
  process.exit(2);
}
