import { spawnSync, type SpawnSyncReturns } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hdc } from '../../src/device/hdc';

vi.mock('child_process', async (importOriginal) => ({
    ...await importOriginal<typeof import('child_process')>(),
    spawnSync: vi.fn(),
}));

function commandResult(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
    return { pid: 123, output: [null, '', ''], stdout: '', stderr: '', status: 0, signal: null, ...overrides };
}

describe('Hdc complete shell command results', () => {
    beforeEach(() => {
        vi.mocked(spawnSync).mockReset();
    });

    it('preserves the complete result and existing spawn options', () => {
        const result = commandResult({ stdout: 'listener output', stderr: 'warning' });
        vi.mocked(spawnSync).mockReturnValue(result);

        expect(new Hdc('127.0.0.1:5555').excuteShellCommandSyncResult('netstat -atn')).toBe(result);
        expect(spawnSync).toHaveBeenCalledWith(
            'hdc', ['-t', '127.0.0.1:5555', 'shell', 'netstat -atn'], { encoding: 'utf-8', shell: true }
        );
    });

    it('preserves a nonzero exit code and stderr', () => {
        const result = commandResult({ status: 255, stderr: 'command failed' });
        vi.mocked(spawnSync).mockReturnValue(result);

        expect(new Hdc().excuteShellCommandSyncResult('ps -ef')).toBe(result);
    });

    it('preserves spawn errors with null stdout instead of throwing from trim()', () => {
        const result = commandResult({ status: null, error: new Error('spawn ENOENT'), stdout: null as unknown as string });
        vi.mocked(spawnSync).mockReturnValue(result);

        expect(new Hdc().excuteShellCommandSyncResult('netstat -atn')).toBe(result);
    });

    it('preserves termination signals', () => {
        const result = commandResult({ status: null, signal: 'SIGTERM' });
        vi.mocked(spawnSync).mockReturnValue(result);

        expect(new Hdc().excuteShellCommandSyncResult('netstat -atn')).toBe(result);
    });

    it('keeps the existing stdout-only interface and optional target behavior', () => {
        vi.mocked(spawnSync).mockReturnValue(commandResult({ stdout: 'process output' }));

        expect(new Hdc().excuteShellCommandSync('ps -ef')).toBe('process output');
        expect(spawnSync).toHaveBeenCalledWith('hdc', ['shell', 'ps -ef'], { encoding: 'utf-8', shell: true });
    });

    it('keeps the existing missing-connectkey error behavior', () => {
        vi.mocked(spawnSync).mockReturnValue(commandResult({
            stdout: '[Fail]ExecuteCommand need connect-key? please confirm a device by help info',
        }));

        expect(() => new Hdc().excuteShellCommandSync('netstat -atn')).toThrow('need connect-key');
    });
});
