import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Component } from '../../src/model/component';
import { Page } from '../../src/model/page';
import { ViewTree } from '../../src/model/viewtree';
import { ExitEvent } from '../../src/event/system_event';
import { TouchEvent } from '../../src/event/ui_event';
import { runSyncCommand } from '../../src/runner/sync_runner';

const runtime = vi.hoisted(() => ({
    createDevice: vi.fn(),
    createPolicy: vi.fn(),
    startAction: vi.fn(),
}));

vi.mock('../../src/device/device', () => ({
    Device: class {
        constructor(options: unknown) {
            return runtime.createDevice(options);
        }
    },
}));

vi.mock('../../src/cli/env_checker', () => ({ EnvChecker: class { check() {} } }));
vi.mock('../../src/policy/policy_builder', () => ({ PolicyBuilder: { buildPolicyByName: runtime.createPolicy } }));
vi.mock('../../src/utils/logger', () => ({
    LOG_LEVEL: { DEBUG: 'debug', INFO: 'info' },
    HapTestLogger: { configure: vi.fn(), getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('../../src/runner/event_action', () => ({
    EventAction: class {
        transition: { from: Page; to: Page; event: unknown };
        constructor(private device: any, private hap: any, page: Page, event: unknown) {
            this.transition = { from: page, to: page, event };
        }
        async start() {
            runtime.startAction(this.device, this.transition.event);
        }
        async stop() {
            this.transition.to = await this.device.getCurrentPage(this.hap);
        }
    },
}));

function createPage(title?: string, ability = 'EntryAbility'): Page {
    const root = new Component();
    root.type = 'Root';
    root.bounds = [{ x: 0, y: 0 }, { x: 800, y: 600 }];
    if (title) {
        const heading = Object.assign(new Component(), { type: 'Text', id: 'page-title', text: title, parent: root });
        root.addChild(heading);
    }
    return new Page(new ViewTree(root), ability, 'com.example.demo', 'pages/MainPage');
}

function setupDevices(leftPages: Array<Page | Error>, rightPages: Array<Page | Error>) {
    const createDevice = (pages: Array<Page | Error>) => {
        let index = 0;
        return {
            getDeviceType: () => 'phone',
            buildHap: () => ({ bundleName: 'com.example.demo' }),
            prepareTest: vi.fn(),
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn().mockResolvedValue(undefined),
            getCurrentPage: vi.fn(async () => {
                const value = pages[Math.min(index++, pages.length - 1)];
                if (value instanceof Error) throw value;
                return value;
            }),
        };
    };
    const left = createDevice(leftPages);
    const right = createDevice(rightPages);
    runtime.createDevice.mockImplementation((options) => options.connectkey === 'left-device' ? left : right);
    return { left, right };
}

async function run() {
    const result = runSyncCommand({
        app: 'com.example.demo',
        left: 'left-device',
        right: 'right-device',
        output: fs.mkdtempSync(path.join(os.tmpdir(), 'haptest-page-flow-')),
        fromCurrentPage: true,
        policy: 'greedy_dfs',
    });
    await vi.runAllTimersAsync();
    return result;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
});

afterEach(() => vi.useRealTimers());

describe('sync operation-page flow', () => {
    it('allows equal logical pages with different Ability entry points to start exploration', async () => {
        setupDevices([createPage('Overview')], [createPage('Overview', 'PcAbility')]);
        const generateEvent = vi.fn().mockResolvedValue(new ExitEvent());
        runtime.createPolicy.mockReturnValue({ enabled: true, generateEvent });
        const result = await run();

        expect(result.status).toBe('completed');
        expect(result.stepResults[0].operationPageCheck.decision).toBe('SAME_PAGE');
        expect(result.stepResults[0].uiConsistent).toBe(false);
        expect(generateEvent).toHaveBeenCalledOnce();
    });

    it('does not create a policy or start any action for an initial confirmed divergence', async () => {
        setupDevices([createPage('Overview')], [createPage('Preferences', 'PcAbility')]);
        const result = await run();

        expect(result.steps).toBe(0);
        expect(result.termination).toBe('FunctionalMismatch');
        expect(result.firstMismatchStep).toBe(0);
        expect(runtime.createPolicy).not.toHaveBeenCalled();
        expect(runtime.startAction).not.toHaveBeenCalled();
    });

    it('recollects uncertain pages twice then stops without recording a confirmed mismatch', async () => {
        const devices = setupDevices([createPage()], [createPage(undefined, 'PcAbility')]);
        const result = await run();

        expect(result.termination).toBe('PageUncertain');
        expect(result.firstMismatchStep).toBeUndefined();
        expect(result.stepResults[0].operationPageCheck.decision).toBe('UNCERTAIN');
        expect(result.stepResults[0].functionalIssues).toEqual([]);
        expect(devices.left.getCurrentPage).toHaveBeenCalledTimes(3);
        expect(devices.right.getCurrentPage).toHaveBeenCalledTimes(3);
        expect(runtime.createPolicy).not.toHaveBeenCalled();
        expect(runtime.startAction).not.toHaveBeenCalled();
    });

    it('uses fresh recollected pages to resolve an uncertain initial check', async () => {
        const devices = setupDevices([createPage(), createPage('Overview')], [createPage(undefined, 'PcAbility'), createPage('Overview', 'PcAbility')]);
        runtime.createPolicy.mockReturnValue({ enabled: true, generateEvent: vi.fn().mockResolvedValue(new ExitEvent()) });
        const result = await run();

        expect(result.status).toBe('completed');
        expect(result.stepResults[0].operationPageCheck.decision).toBe('SAME_PAGE');
        expect(devices.left.getCurrentPage).toHaveBeenCalledTimes(2);
        expect(devices.right.getCurrentPage).toHaveBeenCalledTimes(2);
    });

    it('separates recollection failure from confirmed page divergence', async () => {
        setupDevices([createPage(), new Error('captureLayout failed')], [createPage(undefined, 'PcAbility')]);
        const result = await run();

        expect(result.termination).toBe('PageCollectionFailed');
        expect(result.firstMismatchStep).toBeUndefined();
        expect(result.stepResults[0].operationPageCheck.source).toBe('COLLECTION');
        expect(result.stepResults[0].operationPageCheck.unresolvedIssues.join(' ')).toContain('captureLayout failed');
        expect(runtime.startAction).not.toHaveBeenCalled();
    });

    it('stops before generating the next event after an after-event divergence', async () => {
        setupDevices(
            [createPage('Overview'), createPage('Preferences')],
            [createPage('Overview', 'PcAbility'), createPage('Overview', 'PcAbility')],
        );
        const generateEvent = vi.fn()
            .mockResolvedValueOnce(new TouchEvent({ x: 100, y: 100 }))
            .mockResolvedValue(new ExitEvent());
        runtime.createPolicy.mockReturnValue({ enabled: true, generateEvent });
        const result = await run();

        expect(result.steps).toBe(1);
        expect(result.termination).toBe('FunctionalMismatch');
        expect(result.firstMismatchStep).toBe(1);
        expect(result.stepResults.map((step) => step.operationPageCheck.decision)).toEqual(['SAME_PAGE', 'DIFFERENT_PAGE']);
        expect(generateEvent).toHaveBeenCalledOnce();
        expect(runtime.startAction).toHaveBeenCalledTimes(2);
    });

    it('pauses after an uncertain after-event decision without executing the next event', async () => {
        const devices = setupDevices(
            [createPage('Overview'), createPage()],
            [createPage('Overview', 'PcAbility'), createPage(undefined, 'PcAbility')],
        );
        const generateEvent = vi.fn().mockResolvedValue(new TouchEvent({ x: 100, y: 100 }));
        runtime.createPolicy.mockReturnValue({ enabled: true, generateEvent });
        const result = await run();

        expect(result.steps).toBe(1);
        expect(result.termination).toBe('PageUncertain');
        expect(result.firstMismatchStep).toBeUndefined();
        expect(result.stepResults[1].operationPageCheck.decision).toBe('UNCERTAIN');
        expect(generateEvent).toHaveBeenCalledOnce();
        expect(runtime.startAction).toHaveBeenCalledTimes(2);
        expect(devices.left.getCurrentPage).toHaveBeenCalledTimes(4);
        expect(devices.right.getCurrentPage).toHaveBeenCalledTimes(4);
    });
});
