/*
 * Copyright (c) 2024 Huawei Device Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import path from 'path';
import { Device } from '../device/device';
import { EventBuilder } from '../event/event_builder';
import { Event } from '../event/event';
import { ExitEvent } from '../event/system_event';
import { WaitEvent } from '../event/wait_event';
import { FuzzOptions } from './fuzz_options';
import { EnvChecker } from '../cli/env_checker';
import { HapTestLogger, LOG_LEVEL } from '../utils/logger';
import { PolicyBuilder } from '../policy/policy_builder';
import { Policy } from '../policy/policy';
import { Page } from '../model/page';
import { Hap } from '../model/hap';
import { EventAction } from './event_action';

const EVENT_INTERVAL = 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface SyncResult {
    consistent: boolean;
    steps: number;
    firstMismatchStep?: number;
    leftPageSig: string;
    rightPageSig: string;
    reason?: string;
}

interface SyncDeviceContext {
    device: Device;
    options: FuzzOptions;
    hap: Hap;
    page: Page;
}

function cloneEvent(event: Event): Event {
    return EventBuilder.createEventFromJson(JSON.parse(event.toString()));
}

function createDeviceOptions(baseOptions: any, connectkey: string, outputDir: string): FuzzOptions {
    return {
        connectkey,
        hap: baseOptions.hap,
        policyName: baseOptions.policy,
        output: outputDir,
        coverage: baseOptions.coverage,
        reportRoot: baseOptions.report,
        excludes: baseOptions.exclude,
        llm: false,
        simK: Number(baseOptions.simK),
        staticConfig: baseOptions.staticConfig,
        startFromCurrentPage: baseOptions.fromCurrentPage !== false,
        deviceType: baseOptions.deviceType,
    };
}

async function initializeDevice(deviceOptions: FuzzOptions): Promise<SyncDeviceContext> {
    const device = new Device(deviceOptions);
    const envChecker = new EnvChecker(deviceOptions);
    envChecker.check();

    deviceOptions.deviceType = device.getDeviceType();

    const hap = device.buildHap(deviceOptions.sourceRoot, deviceOptions.hapFile, deviceOptions.bundleName);
    await device.connect(hap);

    const page = await device.getCurrentPage(hap, true);
    return { device, options: deviceOptions, hap, page };
}

export function compareSyncPages(leftPage: Page, rightPage: Page): { consistent: boolean; leftPageSig: string; rightPageSig: string } {
    const leftPageSig = leftPage.getContentSig();
    const rightPageSig = rightPage.getContentSig();
    return {
        consistent: leftPageSig === rightPageSig,
        leftPageSig,
        rightPageSig,
    };
}

async function stopDevice(device: Device): Promise<void> {
    try {
        await device.disconnect();
    } catch {
        // ignore cleanup errors
    }
}

export async function runSyncCommand(options: any): Promise<SyncResult> {
    const outputDir = path.resolve(options.output ?? 'out/sync');
    fs.mkdirSync(outputDir, { recursive: true });
    HapTestLogger.configure(path.join(outputDir, 'haptest.log'), options.debug ? LOG_LEVEL.DEBUG : LOG_LEVEL.INFO);

    if (options.llm) {
        throw new Error('sync command does not support --llm. Use a deterministic policy for lockstep execution.');
    }

    const hapList: string[] = Array.isArray(options.hap) ? options.hap : options.hap != null ? [options.hap] : [];
    if (hapList.length !== 1) {
        throw new Error('sync command requires exactly one -i/--hap value shared by both devices.');
    }

    const sharedHap = hapList[0];
    const leftOptions = createDeviceOptions({ ...options, hap: sharedHap }, options.left, path.join(outputDir, 'left'));
    const rightOptions = createDeviceOptions({ ...options, hap: sharedHap }, options.right, path.join(outputDir, 'right'));

    const [left, right] = await Promise.all([initializeDevice(leftOptions), initializeDevice(rightOptions)]);
    const policy: Policy = PolicyBuilder.buildPolicyByName(left.device, left.hap, left.options);

    let steps = 0;
    let currentLeftPage = left.page;
    let currentRightPage = right.page;
    const initialCompare = compareSyncPages(currentLeftPage, currentRightPage);

    if (!initialCompare.consistent) {
        await Promise.all([stopDevice(left.device), stopDevice(right.device)]);
        const result: SyncResult = {
            consistent: false,
            steps,
            firstMismatchStep: 0,
            leftPageSig: initialCompare.leftPageSig,
            rightPageSig: initialCompare.rightPageSig,
            reason: 'Initial pages are not identical.',
        };
        fs.writeFileSync(path.join(outputDir, 'sync-result.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
        return result;
    }

    while (policy.enabled) {
        const event = await policy.generateEvent(currentLeftPage);

        if (event instanceof WaitEvent) {
            await sleep(1500);
            continue;
        }

        if (event instanceof ExitEvent) {
            break;
        }

        const leftEvent = event;
        const rightEvent = cloneEvent(event);
        const leftAction = new EventAction(left.device, left.hap, currentLeftPage, leftEvent, left.options.deviceType);
        const rightAction = new EventAction(right.device, right.hap, currentRightPage, rightEvent, right.options.deviceType);

        try {
            await Promise.all([leftAction.start(), rightAction.start()]);
            await sleep(EVENT_INTERVAL);
            await Promise.all([leftAction.stop(), rightAction.stop()]);
        } catch (error) {
            await Promise.all([stopDevice(left.device), stopDevice(right.device)]);
            const result: SyncResult = {
                consistent: false,
                steps,
                firstMismatchStep: steps + 1,
                leftPageSig: leftAction.transition.from.getContentSig(),
                rightPageSig: rightAction.transition.from.getContentSig(),
                reason: `Event execution failed: ${String(error)}`,
            };
            fs.writeFileSync(path.join(outputDir, 'sync-result.json'), JSON.stringify(result, null, 2));
            console.log(JSON.stringify(result));
            return result;
        }

        steps += 1;
        currentLeftPage = leftAction.transition.to;
        currentRightPage = rightAction.transition.to;

        const compare = compareSyncPages(currentLeftPage, currentRightPage);
        if (!compare.consistent) {
            await Promise.all([stopDevice(left.device), stopDevice(right.device)]);
            const result: SyncResult = {
                consistent: false,
                steps,
                firstMismatchStep: steps,
                leftPageSig: compare.leftPageSig,
                rightPageSig: compare.rightPageSig,
                reason: 'Pages diverged after synchronized execution.',
            };
            fs.writeFileSync(path.join(outputDir, 'sync-result.json'), JSON.stringify(result, null, 2));
            console.log(JSON.stringify(result));
            return result;
        }
    }

    await Promise.all([stopDevice(left.device), stopDevice(right.device)]);
    const finalCompare = compareSyncPages(currentLeftPage, currentRightPage);
    const result: SyncResult = {
        consistent: finalCompare.consistent,
        steps,
        leftPageSig: finalCompare.leftPageSig,
        rightPageSig: finalCompare.rightPageSig,
        reason: finalCompare.consistent ? 'Pages stayed consistent for all synchronized steps.' : 'Final pages diverged.',
    };
    fs.writeFileSync(path.join(outputDir, 'sync-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    return result;
}