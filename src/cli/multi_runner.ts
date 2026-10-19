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
import { ChildProcess, spawn } from 'child_process';
import { HapTestLogger, LOG_LEVEL } from '../utils/logger';
import { FuzzOptions } from '../runner/fuzz_options';
import { EnvChecker } from './env_checker';
import { getLogger } from 'log4js';

const logger = getLogger();

export interface MultiDeviceTargetConfig {
    connectkey: string;
    name?: string;
    output?: string;
    deviceType?: string;
    startFromCurrentPage?: boolean;
    coverage?: boolean;
    reportRoot?: string;
    excludes?: string[];
    llm?: boolean;
    simK?: number;
    staticConfig?: string;
    policyName?: string;
}

export interface MultiDeviceConfigFile {
    targets: MultiDeviceTargetConfig[];
}

export interface MultiDeviceSharedOptions {
    hap: string;
    output: string;
    policyName: string;
    coverage: boolean;
    reportRoot?: string;
    excludes?: string[];
    startFromCurrentPage?: boolean;
    llm?: boolean;
    simK: number;
    staticConfig?: string;
    debug?: boolean;
}

export interface MultiRunPlanItem extends FuzzOptions {
    label: string;
}

function sanitizeLabel(value: string): string {
    const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '_');
    return normalized.length > 0 ? normalized : 'target';
}

export function parseMultiDeviceConfig(rawText: string): MultiDeviceConfigFile {
    const parsed = JSON.parse(rawText) as Partial<MultiDeviceConfigFile>;
    if (!parsed || !Array.isArray(parsed.targets)) {
        throw new Error('Multi-device config must contain a targets array.');
    }

    const targets = parsed.targets.map((target, index) => {
        if (!target || typeof target.connectkey !== 'string' || target.connectkey.trim().length === 0) {
            throw new Error(`Multi-device config target at index ${index} is missing connectkey.`);
        }
        return {
            ...target,
            connectkey: target.connectkey.trim(),
            name: target.name?.trim() || undefined,
            output: target.output?.trim() || undefined,
            deviceType: target.deviceType?.trim() || undefined,
            reportRoot: target.reportRoot?.trim() || undefined,
            staticConfig: target.staticConfig?.trim() || undefined,
            policyName: target.policyName?.trim() || undefined,
        };
    });

    if (targets.length === 0) {
        throw new Error('Multi-device config requires at least one target.');
    }

    return { targets };
}

export function buildMultiRunPlan(shared: MultiDeviceSharedOptions, config: MultiDeviceConfigFile): MultiRunPlanItem[] {
    return config.targets.map((target, index) => {
        const labelSource = target.name ?? target.connectkey ?? `target-${index + 1}`;
        const label = sanitizeLabel(labelSource);
        const output = path.resolve(target.output ?? path.join(shared.output, label));
        return {
            connectkey: target.connectkey,
            hap: shared.hap,
            policyName: target.policyName ?? shared.policyName,
            output,
            startFromCurrentPage: target.startFromCurrentPage ?? shared.startFromCurrentPage,
            coverage: target.coverage ?? shared.coverage,
            reportRoot: target.reportRoot ?? shared.reportRoot,
            excludes: target.excludes ?? shared.excludes,
            deviceType: target.deviceType,
            llm: target.llm ?? shared.llm,
            simK: target.simK ?? shared.simK,
            staticConfig: target.staticConfig ?? shared.staticConfig,
            bundleName: undefined,
            sourceRoot: undefined,
            hapFile: undefined,
            label,
        };
    });
}

function buildChildArgs(planItem: MultiRunPlanItem, debug: boolean): string[] {
    const args = [
        'bin/haptest',
        '-i',
        planItem.hap,
        '-o',
        planItem.output,
        '--policy',
        planItem.policyName,
        '-t',
        planItem.connectkey,
    ];

    if (planItem.coverage) {
        args.push('-c');
    }
    if (planItem.reportRoot) {
        args.push('--report', planItem.reportRoot);
    }
    if (planItem.startFromCurrentPage) {
        args.push('--from-current-page');
    }
    if (planItem.llm) {
        args.push('--llm');
    }
    args.push('--simK', String(planItem.simK));
    if (planItem.staticConfig) {
        args.push('--staticConfig', planItem.staticConfig);
    }
    if (planItem.deviceType) {
        args.push('--deviceType', planItem.deviceType);
    }
    if (planItem.excludes && planItem.excludes.length > 0) {
        args.push('--exclude', ...planItem.excludes);
    }
    if (debug) {
        args.push('--debug');
    }

    return args;
}

function spawnChildRun(planItem: MultiRunPlanItem, debug: boolean): ChildProcess {
    const scriptPath = path.resolve(__dirname, '../../bin/haptest');
    const args = [scriptPath, ...buildChildArgs(planItem, debug)];
    logger.info(`Starting device worker: ${planItem.label} -> ${planItem.connectkey} output=${planItem.output}`);
    return spawn(process.execPath, args, {
        stdio: 'inherit',
        env: process.env,
    });
}

function waitForExit(child: ChildProcess): Promise<number> {
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`Worker exited with signal ${signal}.`));
                return;
            }
            resolve(code ?? 0);
        });
    });
}

function terminateChildren(children: ChildProcess[]): void {
    for (const child of children) {
        if (!child.killed) {
            child.kill('SIGTERM');
        }
    }
}

export async function runMultiFuzzCommand(options: any): Promise<void> {
    const outputDir = path.resolve(options.output ?? 'out');
    fs.mkdirSync(outputDir, { recursive: true });
    HapTestLogger.configure(path.join(outputDir, 'haptest.log'), options.debug ? LOG_LEVEL.DEBUG : LOG_LEVEL.INFO);
    logger.info(`haptest multi start by args ${JSON.stringify(options)}.`);

    const hapList: string[] = Array.isArray(options.hap) ? options.hap : options.hap != null ? [options.hap] : [];
    if (hapList.length !== 1) {
        throw new Error('The multi-device command requires exactly one -i/--hap value shared by all targets.');
    }

    const configPath = path.resolve(options.devices);
    if (!fs.existsSync(configPath)) {
        throw new Error(`Multi-device config file not found: ${configPath}`);
    }

    const config = parseMultiDeviceConfig(fs.readFileSync(configPath, { encoding: 'utf-8' }));
    const shared: MultiDeviceSharedOptions = {
        hap: hapList[0],
        output: outputDir,
        policyName: options.policy,
        coverage: options.coverage,
        reportRoot: options.report,
        excludes: options.exclude,
        startFromCurrentPage: options.fromCurrentPage,
        llm: options.llm,
        simK: Number(options.simK),
        staticConfig: options.staticConfig,
        debug: options.debug,
    };

    const plan = buildMultiRunPlan(shared, config);
    for (const planItem of plan) {
        const envChecker = new EnvChecker(planItem);
        envChecker.check();
    }

    const children = plan.map((planItem) => spawnChildRun(planItem, !!options.debug));

    const shutdown = () => terminateChildren(children);
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);

    try {
        const exitCodes = await Promise.all(
            children.map(async (child) => {
                const code = await waitForExit(child);
                if (code !== 0) {
                    throw new Error(`Worker exited with code ${code}.`);
                }
                return code;
            })
        );

        if (exitCodes.length !== plan.length) {
            throw new Error('Some multi-device workers did not complete successfully.');
        }
    } catch (err) {
        terminateChildren(children);
        throw err;
    } finally {
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
    }
}
