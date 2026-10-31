import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hdc } from '../../src/device/hdc';
import { HypiumRpc } from '../../src/device/uidriver/hypium_rpc';
import { UitestAgent } from '../../src/device/uidriver/uitest_agent';

const AGENT_FILE = '/data/local/tmp/agent.so';
const AGENT_FILE_INFO = 'ELF shared object, 64-bit LSB x86-64';
const MARKER_COMMAND = "grep -a -o 'UITEST_AGENT_LIBRARY@[[:alnum:].#]*' " + AGENT_FILE;

interface AgentFixtureOptions {
    installed?: boolean;
    marker?: string;
    uploadedMarker?: string;
    uploadedFileInfo?: string;
}

function createAgentFixture(options: AgentFixtureOptions = {}) {
    let installed = options.installed ?? true;
    let marker = options.marker ?? 'UITEST_AGENT_LIBRARY@v1.1.9';
    let fileInfo = AGENT_FILE_INFO;
    const execute = vi.fn((...args: string[]): string => {
        const command = args.join(' ');
        if (command === '/system/bin/uitest --version') return '7.0.0.1';
        if (command === 'file /system/bin/uitest') return AGENT_FILE_INFO;
        if (command === 'netstat -atn') return 'tcp 0 0 0.0.0.0:8012 0.0.0.0:* LISTEN';
        if (command === 'cat /proc/net/unix') return '';
        if (command === 'ps -ef') return '';
        if (command.startsWith('grep -a -o ')) return marker + '\n';
        if (command === 'file ' + AGENT_FILE) return fileInfo;
        if (command === 'rm -f ' + AGENT_FILE) {
            installed = false;
            return '';
        }
        if (command === '/system/bin/uitest start-daemon singleness &') return '';
        throw new Error('Unexpected device command: ' + command);
    });
    const sendFile = vi.fn(() => {
        installed = true;
        marker = options.uploadedMarker ?? 'UITEST_AGENT_LIBRARY@v1.1.9';
        fileInfo = options.uploadedFileInfo ?? AGENT_FILE_INFO;
        return 0;
    });
    const hdc = {
        hasFile: vi.fn(() => installed),
        excuteShellCommandSync: execute,
        excuteShellCommandSyncResult: vi.fn((...args: string[]) => ({
            stdout: execute(...args), stderr: '', status: 0, signal: null, error: undefined,
        })),
        sendFile,
    } as unknown as Hdc;
    const markerCommands = () => execute.mock.calls
        .map(args => args.join(' '))
        .filter(command => command.startsWith('grep -a -o '));
    return { agent: new UitestAgent(hdc), execute, sendFile, markerCommands };
}

describe('UitestAgent version verification', () => {
    beforeEach(() => {
        vi.spyOn(HypiumRpc.prototype, 'start').mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each([
        ['legacy', 'UITEST_AGENT_LIBRARY@v1.1.9'],
        ['current', 'UITEST_AGENT_LIBRARY@v0.0.0#1.1.9'],
    ])('reuses a compatible installed agent with a %s marker', async (_format, marker) => {
        const fixture = createAgentFixture({ marker });

        await fixture.agent.start();

        expect(fixture.sendFile).not.toHaveBeenCalled();
        expect(fixture.markerCommands()).toEqual([MARKER_COMMAND]);
        expect(HypiumRpc.prototype.start).toHaveBeenCalledTimes(1);
    });

    it('verifies a missing agent after uploading it', async () => {
        const fixture = createAgentFixture({ installed: false });

        await fixture.agent.start();

        expect(fixture.sendFile).toHaveBeenCalledWith(
            expect.stringContaining('uitest_agent_v1.1.9.x86_64_so'), AGENT_FILE,
        );
        expect(fixture.markerCommands()).toEqual([MARKER_COMMAND]);
        expect(HypiumRpc.prototype.start).toHaveBeenCalledTimes(1);
    });

    it('uses the same safe extraction command before and after an upgrade', async () => {
        const fixture = createAgentFixture({ marker: 'UITEST_AGENT_LIBRARY@v1.0.8' });

        await fixture.agent.start();

        expect(fixture.sendFile).toHaveBeenCalledTimes(1);
        expect(fixture.markerCommands()).toEqual([MARKER_COMMAND, MARKER_COMMAND]);
    });

    it.each([
        ['missing version', { uploadedMarker: 'UITEST_AGENT_LIBRARY@' }, /version marker is missing or unrecognized/],
        ['outdated version', { uploadedMarker: 'UITEST_AGENT_LIBRARY@v1.0.8' }, /does not meet required version/],
        ['wrong architecture', { uploadedFileInfo: 'ELF 64-bit LSB shared object, ARM aarch64' }, /ELF architecture does not match/],
    ])('rejects an uploaded agent with %s', async (_description, uploaded, reason) => {
        const fixture = createAgentFixture({ installed: false, ...uploaded });

        await expect(fixture.agent.start()).rejects.toThrow(reason);

        expect(fixture.sendFile).toHaveBeenCalledTimes(1);
        expect(HypiumRpc.prototype.start).not.toHaveBeenCalled();
    });

    it.runIf(process.platform === 'win32')('preserves the actual extraction command through the Windows host shell', async () => {
        const fixture = createAgentFixture();
        await fixture.agent.start();
        const command = fixture.markerCommands()[0];

        const result = spawnSync('echo', ['-t', 'example-device', 'shell', command], {
            encoding: 'utf-8', shell: true,
        });

        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe('-t example-device shell ' + command);
    });
});
