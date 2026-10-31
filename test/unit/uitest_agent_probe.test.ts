import type { SpawnSyncReturns } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hdc } from '../../src/device/hdc';
import { UitestAgent } from '../../src/device/uidriver/uitest_agent';

const TCP_LISTENER = 'tcp 0 0 127.0.0.1:8012 0.0.0.0:* LISTEN';
const UNIX_LISTENER = '00000000: 00000002 00000000 00010000 0001 01 1234 @uitest_socket';
const PS_HEADER = 'UID PID PPID C STIME TTY TIME CMD';

interface AgentProbes {
    isRunning(transport: 'tcp' | 'unix'): boolean;
    getDaemonPids(): string[];
    waitForDaemon(transport: 'tcp' | 'unix'): Promise<void>;
}

function commandResult(stdout = '', overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
    return { pid: 123, output: [null, stdout, ''], stdout, stderr: '', status: 0, signal: null, ...overrides };
}

function createProbeFixture(stdout = '') {
    const execute = vi.fn((_command: string) => commandResult(stdout));
    const hdc = { excuteShellCommandSyncResult: execute } as unknown as Hdc;
    const probes = new UitestAgent(hdc) as unknown as AgentProbes;
    return { execute, probes };
}

describe('UitestAgent pipe-free daemon probes', () => {
    it('detects an IPv4 TCP listener from the complete netstat output with the original regex', () => {
        const fixture = createProbeFixture('Proto Recv-Q Send-Q Local Address Foreign Address State\r\n' + TCP_LISTENER + '\r\n');

        expect(fixture.probes.isRunning('tcp')).toBe(true);
        expect(fixture.execute).toHaveBeenCalledExactlyOnceWith('netstat -atn');
    });

    it.each([
        '',
        'tcp 0 0 127.0.0.1:8013 0.0.0.0:* LISTEN',
        'tcp 0 0 127.0.0.1:8012 127.0.0.1:1234 ESTABLISHED',
    ])('returns false only for a successful TCP query without the expected listener: %s', (stdout) => {
        expect(createProbeFixture(stdout).probes.isRunning('tcp')).toBe(false);
    });

    it('reads the Unix socket table without a pipeline', () => {
        const fixture = createProbeFixture('Num RefCount Protocol Flags Type St Inode Path\n' + UNIX_LISTENER);

        expect(fixture.probes.isRunning('unix')).toBe(true);
        expect(fixture.execute).toHaveBeenCalledExactlyOnceWith('cat /proc/net/unix');
    });

    it('does not confuse TCP listeners and Unix endpoints', () => {
        expect(createProbeFixture(TCP_LISTENER).probes.isRunning('unix')).toBe(false);
        expect(createProbeFixture(UNIX_LISTENER).probes.isRunning('tcp')).toBe(false);
    });

    it('recognizes only the daemon executable and exact arguments, not wrappers or query processes', () => {
        const fixture = createProbeFixture([
            PS_HEADER,
            'shell 31846 1 0 18:20:00 ? 00:00:00 uitest start-daemon singleness',
            'shell 31847 1 0 18:20:00 ? 00:00:00 /system/bin/uitest start-daemon singleness',
            'shell 31848 1 0 18:20:00 ? 00:00:00 ps -ef',
            'shell 31849 1 0 18:20:00 ? 00:00:00 grep uitest start-daemon singleness',
            'shell 31850 1 0 18:20:00 ? 00:00:00 sh -c /system/bin/uitest start-daemon singleness',
            'shell 31851 1 0 18:20:00 ? 00:00:00 another_uitest start-daemon singleness',
            'shell 31852 1 0 18:20:00 ? 00:00:00 uitest start-daemon other',
            'shell 31853 1 0 18:20:00 ? 00:00:00 uitest start-daemon singleness-other',
        ].join('\r\n'));

        expect(fixture.probes.getDaemonPids()).toEqual(['31846', '31847']);
        expect(fixture.execute).toHaveBeenCalledExactlyOnceWith('ps -ef');
    });

    it('uses the process header to locate the command column', () => {
        const fixture = createProbeFixture('USER PID COMMAND\nshell 31846 /system/bin/uitest start-daemon singleness');

        expect(fixture.probes.getDaemonPids()).toEqual(['31846']);
    });

    it('recognizes a standard ps -ef row when a header is absent', () => {
        const fixture = createProbeFixture('shell 31846 1 0 18:20:00 ? 00:00:00 uitest start-daemon singleness');

        expect(fixture.probes.getDaemonPids()).toEqual(['31846']);
    });

    it('returns no daemon PIDs for a successful process query without a daemon', () => {
        expect(createProbeFixture(PS_HEADER).probes.getDaemonPids()).toEqual([]);
    });

    it.each([
        ['nonzero exit', { status: 255, stderr: 'permission denied' }, 'permission denied'],
        ['spawn failure', { status: null, error: new Error('spawn ENOENT') }, 'spawn ENOENT'],
        ['signal', { status: null, signal: 'SIGTERM' as const }, 'SIGTERM'],
        ['missing stdout', { stdout: null as unknown as string }, 'stdout=null'],
    ])('reports %s rather than treating it as an absent listener', (_description, overrides, reason) => {
        const fixture = createProbeFixture();
        fixture.execute.mockReturnValue(commandResult(TCP_LISTENER, overrides));

        expect(() => fixture.probes.isRunning('tcp')).toThrow(reason);
        expect(() => fixture.probes.isRunning('tcp')).toThrow('netstat -atn');
    });

    it.each(['unix', 'process'] as const)('reports a failed %s query instead of an empty result', (probe) => {
        const fixture = createProbeFixture();
        fixture.execute.mockReturnValue(commandResult('', { status: 1, stderr: 'query failed' }));

        expect(() => probe === 'unix' ? fixture.probes.isRunning('unix') : fixture.probes.getDaemonPids())
            .toThrow('query failed');
    });
});

describe('UitestAgent daemon polling', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it.each(['tcp', 'unix'] as const)('retries a successful %s query after 250ms and stops once the endpoint appears', async (transport) => {
        const fixture = createProbeFixture(transport === 'tcp' ? TCP_LISTENER : UNIX_LISTENER);
        fixture.execute.mockReturnValueOnce(commandResult());
        const completion = expect(fixture.probes.waitForDaemon(transport)).resolves.toBeUndefined();

        expect(fixture.execute).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(249);
        expect(fixture.execute).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await completion;
        expect(fixture.execute).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps the 10-second timeout for successful queries without a listener', async () => {
        const fixture = createProbeFixture();
        const completion = expect(fixture.probes.waitForDaemon('tcp')).rejects.toThrow('within 10 seconds');

        await vi.advanceTimersByTimeAsync(9999);
        expect(fixture.execute).toHaveBeenCalledTimes(40);
        await vi.advanceTimersByTimeAsync(1);
        await completion;
        expect(fixture.execute).toHaveBeenCalledTimes(40);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('fails immediately on an unsuccessful command without scheduling retries', async () => {
        const fixture = createProbeFixture();
        fixture.execute.mockReturnValue(commandResult('', { status: 255, stderr: 'command failed' }));

        await expect(fixture.probes.waitForDaemon('tcp')).rejects.toThrow('status=255');
        expect(fixture.execute).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('aborts polling if a later command fails instead of waiting for a misleading timeout', async () => {
        const fixture = createProbeFixture();
        fixture.execute.mockReturnValueOnce(commandResult()).mockReturnValue(commandResult('', {
            status: 1, stderr: 'device disconnected',
        }));
        const completion = expect(fixture.probes.waitForDaemon('tcp')).rejects.toThrow('device disconnected');

        await vi.advanceTimersByTimeAsync(250);
        await completion;
        expect(fixture.execute).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });
});
