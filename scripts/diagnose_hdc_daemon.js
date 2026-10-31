const { spawnSync } = require('child_process');

const connectkey = process.argv[2] || '127.0.0.1:5555';
const command = 'hdc';
const spawnOptions = { encoding: 'utf-8', shell: true };
const newline = /\r\n|\n/;
const portPattern = new RegExp('\\b:8012\\b.*\\bLISTEN\\b');
const cases = [
    { label: 'A', remoteCommand: 'netstat -atn' },
    { label: 'B', remoteCommand: 'netstat -atn | grep :8012' },
    { label: 'C', remoteCommand: 'ps -ef | grep uitest' },
];

function serializeError(error) {
    if (!error) return null;
    return Object.fromEntries(Object.getOwnPropertyNames(error).map((property) => [property, error[property]]));
}

function inspectPortOutput(stdout) {
    if (typeof stdout !== 'string') {
        return {
            pattern: portPattern.toString(),
            isRunning: null,
            error: 'stdout is not a string; the existing isRunning() would throw when calling split().',
        };
    }

    const lines = stdout.split(newline);
    return {
        pattern: portPattern.toString(),
        isRunning: lines.some((line) => portPattern.test(line)),
        portLines: lines
            .filter((line) => line.includes(':8012'))
            .map((line) => ({ line, matches: portPattern.test(line) })),
    };
}

console.log(JSON.stringify({
    platform: process.platform,
    nodeVersion: process.version,
    comspec: process.env.ComSpec || process.env.COMSPEC || null,
    connectkey,
    spawnOptions,
    note: 'Remote commands are single arguments without additional literal quotes, matching Hdc.excuteShellCommandSync().',
}, null, 2));

const results = [];
for (const testCase of cases) {
    const args = ['-t', connectkey, 'shell', testCase.remoteCommand];
    console.log(`\n=== ${testCase.label}: ${command} ${args.join(' ')} ===`);
    console.log(JSON.stringify({ command, args, options: spawnOptions }, null, 2));

    const capturedAt = new Date().toISOString();
    const startedAt = Date.now();
    const result = spawnSync(command, args, spawnOptions);
    const record = {
        label: testCase.label,
        capturedAt,
        durationMs: Date.now() - startedAt,
        command,
        args,
        status: result.status,
        signal: result.signal,
        error: serializeError(result.error),
        stdout: result.stdout,
        stderr: result.stderr,
    };
    if (testCase.label !== 'C') record.portProbe = inspectPortOutput(result.stdout);
    results.push(record);
    console.log(JSON.stringify(record, null, 2));
}

const baseline = results.find((result) => result.label === 'A');
const daemonProbe = results.find((result) => result.label === 'B');
console.log('\n=== Comparison with UitestAgent.waitForDaemon() ===');
console.log(JSON.stringify({
    baselinePortProbe: baseline.portProbe,
    actualHapTestPortProbe: {
        label: daemonProbe.label,
        stdout: daemonProbe.stdout,
        status: daemonProbe.status,
        stderr: daemonProbe.stderr,
        ...daemonProbe.portProbe,
    },
    waitForDaemon: {
        timeoutMs: 10000,
        retryDelayMs: 250,
        wouldReturnOnThisSample: daemonProbe.portProbe.isRunning,
        note: 'One sample only. This script does not start a daemon or run the 10-second polling loop.',
    },
}, null, 2));

if (results.some((result) => result.error || result.status !== 0)) process.exitCode = 1;
