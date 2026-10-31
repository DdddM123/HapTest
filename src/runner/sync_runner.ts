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
import { detectComponentDiffIssues } from '../compare/detectors/diff_detector';
import { detectDynamicPageIssues } from '../compare/detectors/dynamic_detector';
import { CompareComponentDiffIssue, CompareDynamicIssue } from '../compare/types';
import { Component } from '../model/component';
import { Point } from '../model/point';
import { SerializeUtils } from '../utils/serialize_utils';
import { checkOperationPages, OperationPageCheckResult } from '../compare/operation_page_checker';

const EVENT_INTERVAL = 1000;
const PAGE_CHECK_RETRY_LIMIT = 2;
const PAGE_CHECK_RETRY_DELAY = 300;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const logger = HapTestLogger.getLogger();

export interface SyncResult {
    status: 'running' | 'completed' | 'failed' | 'interrupted';
    consistent: boolean;
    uiConsistent: boolean;
    steps: number;
    firstMismatchStep?: number;
    leftPageSig: string;
    rightPageSig: string;
    reason?: string;
    termination: 'ExitEvent' | 'FunctionalMismatch' | 'EventFailure' | 'PageUncertain' | 'PageCollectionFailed';
    stepResults: SyncStepResult[];
}

export interface SyncStepResult {
    step: number;
    event?: Record<string, any>;
    leftEvent?: Record<string, any>;
    rightEvent?: Record<string, any>;
    leftActionStatus: 'not-run' | 'succeeded' | 'failed';
    rightActionStatus: 'not-run' | 'succeeded' | 'failed';
    leftError?: string;
    rightError?: string;
    leftBeforePageSig: string;
    rightBeforePageSig: string;
    leftBeforePagePath: string;
    rightBeforePagePath: string;
    leftPageSig: string;
    rightPageSig: string;
    leftPagePath: string;
    rightPagePath: string;
    consistent: boolean;
    pageMatched: boolean;
    operationPageCheck: OperationPageCheckResult;
    uiConsistent: boolean;
    componentDiffs: CompareComponentDiffIssue[];
    functionalIssues: CompareDynamicIssue[];
    error?: string;
}

interface SyncStepContext {
    targetBundleName?: string;
    leftBeforePage?: Page;
    rightBeforePage?: Page;
    leftEvent?: Event;
    rightEvent?: Event;
    leftActionStatus?: 'not-run' | 'succeeded' | 'failed';
    rightActionStatus?: 'not-run' | 'succeeded' | 'failed';
    leftError?: string;
    rightError?: string;
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

export function mapEventToPage(event: Event, fromPage: Page, toPage: Page): Event {
    const json = JSON.parse(event.toString());
    const fromComponent = json.component ? SerializeUtils.plainToInstance(Component, json.component) : undefined;
    const toComponent = fromComponent ? findMatchingComponent(fromComponent, json.point, toPage) : undefined;
    if (fromComponent && !toComponent) {
        throw new Error(`Unable to match component ${describeComponent(fromComponent)} on the right page.`);
    }

    if (toComponent) {
        json.component = SerializeUtils.instanceToPlain(toComponent);
        json.point = toComponent.getCenterPoint();
    } else if (json.point) {
        json.point = mapPoint(json.point, getPageBounds(fromPage), getPageBounds(toPage));
    }

    if (json.toComponent) {
        const fromToComponent = SerializeUtils.plainToInstance(Component, json.toComponent);
        const toToComponent = findMatchingComponent(fromToComponent, json.toPoint, toPage);
        if (!toToComponent) {
            throw new Error(`Unable to match destination component ${describeComponent(fromToComponent)} on the right page.`);
        }
        json.toComponent = SerializeUtils.instanceToPlain(toToComponent);
        json.toPoint = toToComponent.getCenterPoint();
    } else if (json.toPoint) {
        json.toPoint = mapPoint(json.toPoint, getPageBounds(fromPage), getPageBounds(toPage));
    }

    return EventBuilder.createEventFromJson(json);
}

function findMatchingComponent(source: Component, sourcePoint: Point | undefined, page: Page): Component | undefined {
    const components = page.getComponents().filter((component) => component.type === source.type);
    if (components.length === 0) {
        return undefined;
    }

    const sourceIdentity = source.key?.trim() || source.id?.trim();
    const identityMatches = sourceIdentity
        ? components.filter((component) => (component.key?.trim() || component.id?.trim()) === sourceIdentity)
        : [];
    const candidates = identityMatches.length > 0 ? identityMatches : components;
    const sourceText = source.text?.trim() || source.hint?.trim();
    const textMatches = sourceText
        ? candidates.filter((component) => (component.text?.trim() || component.hint?.trim()) === sourceText)
        : [];
    const ranked = textMatches.length > 0 ? textMatches : candidates;
    if (ranked.length === 1 || !sourcePoint) {
        return ranked[0];
    }

    const sourceBounds = getPageBoundsForComponent(source);
    return ranked
        .map((component) => ({
            component,
            distance: relativePointDistance(sourcePoint, sourceBounds, component.getCenterPoint(), getPageBounds(page)),
        }))
        .sort((left, right) => left.distance - right.distance)[0]?.component;
}

function describeComponent(component: Component): string {
    return component.key?.trim() || component.id?.trim() || component.text?.trim() || component.type || 'unknown';
}

function getPageBounds(page: Page): { left: number; top: number; width: number; height: number } {
    return getPageBoundsForComponent(page.getRoot());
}

function getPageBoundsForComponent(component: Component): { left: number; top: number; width: number; height: number } {
    const bounds = component.bounds ?? component.origBounds;
    if (!bounds || bounds.length < 2) {
        return { left: 0, top: 0, width: 1, height: 1 };
    }
    return {
        left: Math.min(bounds[0].x, bounds[1].x),
        top: Math.min(bounds[0].y, bounds[1].y),
        width: Math.max(1, Math.abs(bounds[1].x - bounds[0].x)),
        height: Math.max(1, Math.abs(bounds[1].y - bounds[0].y)),
    };
}

function relativePointDistance(
    sourcePoint: Point,
    sourceBounds: { left: number; top: number; width: number; height: number },
    targetPoint: Point,
    targetBounds: { left: number; top: number; width: number; height: number }
): number {
    const sourceX = (sourcePoint.x - sourceBounds.left) / sourceBounds.width;
    const sourceY = (sourcePoint.y - sourceBounds.top) / sourceBounds.height;
    const targetX = (targetPoint.x - targetBounds.left) / targetBounds.width;
    const targetY = (targetPoint.y - targetBounds.top) / targetBounds.height;
    return Math.hypot(sourceX - targetX, sourceY - targetY);
}

function mapPoint(
    point: Point,
    fromBounds: { left: number; top: number; width: number; height: number },
    toBounds: { left: number; top: number; width: number; height: number }
): Point {
    return {
        x: Math.round(toBounds.left + ((point.x - fromBounds.left) / fromBounds.width) * toBounds.width),
        y: Math.round(toBounds.top + ((point.y - fromBounds.top) / fromBounds.height) * toBounds.height),
    };
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
    device.prepareTest(hap);
    await device.connect();

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

export async function diagnoseSyncStep(
    step: number,
    leftPage: Page,
    rightPage: Page,
    event?: Event,
    error?: string,
    context: SyncStepContext = {}
): Promise<SyncStepResult> {
    const comparison = compareSyncPages(leftPage, rightPage);
    const operationPageCheck = checkOperationPages(leftPage, rightPage, context.targetBundleName);
    const leftScreenshot = leftPage.getSnapshot()?.screenCapPath ?? '';
    const rightScreenshot = rightPage.getSnapshot()?.screenCapPath ?? '';
    const componentDiffs = await detectComponentDiffIssues(
        step,
        leftPage,
        rightPage,
        leftScreenshot,
        rightScreenshot
    );
    const functionalIssues = detectDynamicPageIssues(
        step,
        leftPage,
        rightPage,
        leftScreenshot,
        rightScreenshot,
        operationPageCheck
    );
    const pageMatched = operationPageCheck.decision === 'SAME_PAGE';
    const leftBeforePage = context.leftBeforePage ?? leftPage;
    const rightBeforePage = context.rightBeforePage ?? rightPage;
    return {
        step,
        event: event?.toJson(),
        leftEvent: context.leftEvent?.toJson() ?? event?.toJson(),
        rightEvent: context.rightEvent?.toJson() ?? event?.toJson(),
        leftActionStatus: context.leftActionStatus ?? 'not-run',
        rightActionStatus: context.rightActionStatus ?? 'not-run',
        leftError: context.leftError,
        rightError: context.rightError,
        leftBeforePageSig: leftBeforePage.getContentSig(),
        rightBeforePageSig: rightBeforePage.getContentSig(),
        leftBeforePagePath: leftBeforePage.getPagePath(),
        rightBeforePagePath: rightBeforePage.getPagePath(),
        leftPageSig: comparison.leftPageSig,
        rightPageSig: comparison.rightPageSig,
        leftPagePath: leftPage.getPagePath(),
        rightPagePath: rightPage.getPagePath(),
        consistent: pageMatched && functionalIssues.length === 0,
        pageMatched,
        operationPageCheck,
        uiConsistent: comparison.consistent,
        componentDiffs,
        functionalIssues,
        error,
    };
}

interface SyncExecutionError {
    leftError?: string;
    rightError?: string;
}

function getExecutionError(error: unknown): SyncExecutionError {
    if (typeof error === 'object' && error !== null && ('leftError' in error || 'rightError' in error)) {
        const executionError = error as SyncExecutionError;
        return {
            leftError: executionError.leftError,
            rightError: executionError.rightError,
        };
    }
    return { leftError: String(error), rightError: String(error) };
}

async function evaluatePagePair(
    left: SyncDeviceContext,
    right: SyncDeviceContext,
    leftPage: Page,
    rightPage: Page,
    step: number,
    event?: Event,
    context: SyncStepContext = {}
): Promise<{ leftPage: Page; rightPage: Page; result: SyncStepResult }> {
    context = { ...context, targetBundleName: left.hap.bundleName };
    let result = await diagnoseSyncStep(step, leftPage, rightPage, event, undefined, context);
    for (let attempt = 0; attempt < PAGE_CHECK_RETRY_LIMIT && result.operationPageCheck.decision === 'UNCERTAIN'; attempt += 1) {
        logger.info(`[sync-page-check] step=${step} decision=UNCERTAIN rule=${result.operationPageCheck.rule} action=RECOLLECT attempt=${attempt + 1}/${PAGE_CHECK_RETRY_LIMIT}`);
        await sleep(PAGE_CHECK_RETRY_DELAY);
        try {
            [leftPage, rightPage] = await Promise.all([
                left.device.getCurrentPage(left.hap, true),
                right.device.getCurrentPage(right.hap, true),
            ]);
            result = await diagnoseSyncStep(step, leftPage, rightPage, event, undefined, context);
        } catch (error) {
            result.operationPageCheck = {
                ...result.operationPageCheck,
                source: 'COLLECTION',
                rule: 'COLLECTION_INVALID',
                reason: 'Page recollection failed while resolving an uncertain operation-page decision.',
                unresolvedIssues: [...result.operationPageCheck.unresolvedIssues, String(error)],
            };
            break;
        }
    }
    logger.info(`[sync-page-check] step=${step} phase=${step === 0 ? 'initial' : 'after_event'} decision=${result.operationPageCheck.decision} rule=${result.operationPageCheck.rule} reason=${JSON.stringify(result.operationPageCheck.reason)} evidence=${JSON.stringify(result.operationPageCheck.evidence)} action=${result.consistent ? 'CONTINUE' : 'STOP'}`);
    return { leftPage, rightPage, result };
}

function pageCheckTermination(step: SyncStepResult): SyncResult['termination'] | undefined {
    if (step.operationPageCheck.source === 'COLLECTION') return 'PageCollectionFailed';
    if (step.operationPageCheck.decision === 'UNCERTAIN') return 'PageUncertain';
    return step.functionalIssues.length > 0 ? 'FunctionalMismatch' : undefined;
}

async function stopDevice(device: Device): Promise<void> {
    try {
        await device.disconnect();
    } catch {
        // ignore cleanup errors
    }
}

async function captureCurrentPage(context: SyncDeviceContext, fallback: Page): Promise<Page> {
    try {
        return await context.device.getCurrentPage(context.hap);
    } catch {
        return fallback;
    }
}

function sanitizePackageName(packageName: string): string {
    return packageName.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function createRunId(packageName: string): string {
    const now = new Date();
    const timestamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
        String(now.getMilliseconds()).padStart(3, '0'),
    ].join('');
    return `${sanitizePackageName(packageName)}-${timestamp}`;
}

function writeSyncResult(reportPath: string, result: SyncResult): void {
    const temporaryPath = `${reportPath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(result, null, 2));
    fs.renameSync(temporaryPath, reportPath);
}

export function writeSyncMarkdownReport(reportPath: string, result: SyncResult): string {
    const markdownPath = path.join(path.dirname(reportPath), `${path.basename(reportPath, path.extname(reportPath))}.md`);
    const lines: string[] = [
        '# Sync Issue Summary',
        '',
        `- Status: ${result.status}`,
        `- Termination: ${result.termination}`,
        `- Reason: ${result.reason ?? ''}`,
        `- UI consistent: ${result.uiConsistent ? 'yes' : 'no'}`,
        `- Issue steps: ${result.stepResults.filter((stepResult) =>
            stepResult.componentDiffs.length > 0 || stepResult.functionalIssues.length > 0 || stepResult.operationPageCheck?.decision === 'UNCERTAIN'
        ).length}`,
        '',
    ];
    const issueSteps = result.stepResults.filter((stepResult) =>
        stepResult.componentDiffs.length > 0 || stepResult.functionalIssues.length > 0 || stepResult.operationPageCheck?.decision === 'UNCERTAIN'
    );

    if (issueSteps.length === 0) {
        lines.push('No issues found.', '');
    } else {
        for (const stepResult of issueSteps) {
            lines.push(`## Step ${stepResult.step}`, '');
            appendMarkdownScreenshots(lines, reportPath, stepResult);

            if (stepResult.operationPageCheck) {
                const check = stepResult.operationPageCheck;
                lines.push('### Operation page decision', '', `- ${check.decision} (${check.rule}): ${escapeMarkdown(check.reason)}`);
                for (const evidence of [...check.evidence, ...check.unresolvedIssues]) {
                    lines.push(`- ${escapeMarkdown(evidence)}`);
                }
                lines.push('');
            }

            if (stepResult.componentDiffs.length > 0) {
                lines.push('### UI differences', '');
                for (const issue of stepResult.componentDiffs) {
                    lines.push(`- **${escapeMarkdown(issue.componentName)}** (parent: ${escapeMarkdown(issue.parentName)})`);
                    appendDiffKinds(lines, issue.diffs.structuralDiffs, 'layout or structure');
                    appendDiffKinds(lines, issue.diffs.statusDiffs, 'component status');
                    appendDiffKinds(lines, issue.diffs.textDiffs, 'text or content');
                }
                lines.push('');
            }

            if (stepResult.functionalIssues.length > 0) {
                lines.push('### Functional issues', '');
                for (const issue of stepResult.functionalIssues) {
                    const component = issue.componentName ? `: ${escapeMarkdown(issue.componentName)}` : '';
                    lines.push(`- **${issue.kind}**${component}: ${escapeMarkdown(issue.reason)}`);
                }
                lines.push('');
            }
        }
    }

    fs.writeFileSync(markdownPath, `${lines.join('\n')}\n`, { encoding: 'utf-8' });
    logger.info(`Sync markdown report saved: ${markdownPath}`);
    return markdownPath;
}

function appendMarkdownScreenshots(lines: string[], reportPath: string, stepResult: SyncStepResult): void {
    const mobileScreenshot = getMarkdownScreenshotPath(reportPath, stepResult.componentDiffs[0]?.mobileScreenshot
        || stepResult.functionalIssues[0]?.mobileScreenshot || stepResult.operationPageCheck?.leftSummary.collection?.screenshotPath);
    const twoInOneScreenshot = getMarkdownScreenshotPath(reportPath, stepResult.componentDiffs[0]?.twoInOneScreenshot
        || stepResult.functionalIssues[0]?.twoInOneScreenshot || stepResult.operationPageCheck?.rightSummary.collection?.screenshotPath);
    if (!mobileScreenshot && !twoInOneScreenshot) {
        return;
    }
    lines.push('| Mobile | 2in1 |', '| --- | --- |');
    lines.push(
        `| ${mobileScreenshot ? `![mobile screenshot](${mobileScreenshot})` : 'Not available'} | ` +
        `${twoInOneScreenshot ? `![2in1 screenshot](${twoInOneScreenshot})` : 'Not available'} |`,
        ''
    );
}

function getMarkdownScreenshotPath(reportPath: string, screenshotPath: string | undefined): string {
    if (!screenshotPath) {
        return '';
    }
    return path.relative(path.dirname(reportPath), screenshotPath).split(path.sep).join('/');
}

function appendDiffKinds(
    lines: string[],
    diffs: Array<{ field: string; mobileValue: string; twoInOneValue: string }>,
    description: string
): void {
    if (diffs.length > 0) {
        lines.push(`  - ${description} (${diffs.length} issue${diffs.length === 1 ? '' : 's'})`);
    }
}

function escapeMarkdown(value: string): string {
    return value.replace(/[\\`*_{}\[\]()#+.!|>-]/g, '\\$&');
}

function createSyncResult(
    status: SyncResult['status'],
    steps: number,
    leftPage: Page,
    rightPage: Page,
    stepResults: SyncStepResult[],
    reason: string,
    termination: SyncResult['termination'],
    firstMismatchStep?: number
): SyncResult {
    const finalCompare = compareSyncPages(leftPage, rightPage);
    const functionalConsistent = stepResults.every((stepResult) => stepResult.consistent);
    const uiConsistent = stepResults.every((stepResult) => stepResult.uiConsistent);
    return {
        status,
        consistent: functionalConsistent,
        uiConsistent: finalCompare.consistent && uiConsistent,
        steps,
        firstMismatchStep,
        leftPageSig: finalCompare.leftPageSig,
        rightPageSig: finalCompare.rightPageSig,
        reason,
        termination,
        stepResults,
    };
}

export async function runSyncCommand(options: any): Promise<SyncResult> {
    const baseOutputDir = path.resolve(options.output ?? 'out/sync');

    if (options.llm) {
        throw new Error('sync command does not support --llm. Use a deterministic policy for lockstep execution.');
    }

    const sharedHap = typeof options.app === 'string' ? options.app.trim() : '';
    if (!sharedHap) {
        throw new Error('sync command requires exactly one --app value shared by both devices.');
    }

    const runId = createRunId(sharedHap);
    const outputDir = path.join(baseOutputDir, runId);
    fs.mkdirSync(outputDir, { recursive: true });
    HapTestLogger.configure(path.join(outputDir, 'haptest.log'), options.debug ? LOG_LEVEL.DEBUG : LOG_LEVEL.INFO);

    const leftOptions = createDeviceOptions({ ...options, hap: sharedHap }, options.left, path.join(outputDir, 'left'));
    const rightOptions = createDeviceOptions({ ...options, hap: sharedHap }, options.right, path.join(outputDir, 'right'));

    const [left, right] = await Promise.all([initializeDevice(leftOptions), initializeDevice(rightOptions)]);

    let steps = 0;
    let currentLeftPage = left.page;
    let currentRightPage = right.page;
    const stepResults: SyncStepResult[] = [];
    const initial = await evaluatePagePair(left, right, currentLeftPage, currentRightPage, 0);
    currentLeftPage = initial.leftPage;
    currentRightPage = initial.rightPage;
    const initialStep = initial.result;
    stepResults.push(initialStep);
    const reportPath = path.join(outputDir, `sync-result-${runId}.json`);
    fs.mkdirSync(baseOutputDir, { recursive: true });
    let stopRequested = false;
    const handleInterrupt = () => {
        stopRequested = true;
        logger.warn('Sync interruption requested; finishing the current action and saving the report.');
    };
    process.once('SIGINT', handleInterrupt);
    const finalize = (result: SyncResult): SyncResult => {
        process.removeListener('SIGINT', handleInterrupt);
        writeSyncResult(reportPath, result);
        writeSyncMarkdownReport(reportPath, result);
        return result;
    };
    writeSyncResult(reportPath, createSyncResult(
        'running',
        steps,
        currentLeftPage,
        currentRightPage,
        stepResults,
        'Initial operation-page check completed; evaluating whether synchronized execution can start.',
        'ExitEvent'
    ));

    const initialTermination = pageCheckTermination(initialStep);
    if (initialTermination) {
        await Promise.all([stopDevice(left.device), stopDevice(right.device)]);
        return finalize(createSyncResult(
            'failed',
            steps,
            currentLeftPage,
            currentRightPage,
            stepResults,
            initialTermination === 'FunctionalMismatch' ? 'Initial pages have incompatible functional states.' : initialStep.operationPageCheck.reason,
            initialTermination,
            initialTermination === 'FunctionalMismatch' ? 0 : undefined
        ));
    }

    const policy: Policy = PolicyBuilder.buildPolicyByName(left.device, left.hap, left.options);
    while (policy.enabled && !stopRequested) {
        const event = await policy.generateEvent(currentLeftPage);

        if (event instanceof WaitEvent) {
            await sleep(1500);
            continue;
        }

        if (event instanceof ExitEvent) {
            break;
        }

        const leftEvent = event;
        let rightEvent = cloneEvent(event);
        let rightMappingError: string | undefined;
        try {
            rightEvent = mapEventToPage(event, currentLeftPage, currentRightPage);
        } catch (error) {
            rightMappingError = String(error);
        }
        const leftAction = new EventAction(left.device, left.hap, currentLeftPage, leftEvent, left.options.deviceType);
        const rightAction = new EventAction(right.device, right.hap, currentRightPage, rightEvent, right.options.deviceType);

        try {
            if (rightMappingError) {
                throw { rightError: rightMappingError } satisfies SyncExecutionError;
            }
            const startResults = await Promise.allSettled([leftAction.start(), rightAction.start()]);
            if (startResults.some((result) => result.status === 'rejected')) {
                throw {
                    leftError: startResults[0].status === 'rejected' ? String(startResults[0].reason) : undefined,
                    rightError: startResults[1].status === 'rejected' ? String(startResults[1].reason) : undefined,
                } satisfies SyncExecutionError;
            }
            await sleep(EVENT_INTERVAL);
            const stopResults = await Promise.allSettled([leftAction.stop(), rightAction.stop()]);
            if (stopResults.some((result) => result.status === 'rejected')) {
                throw {
                    leftError: stopResults[0].status === 'rejected' ? String(stopResults[0].reason) : undefined,
                    rightError: stopResults[1].status === 'rejected' ? String(stopResults[1].reason) : undefined,
                } satisfies SyncExecutionError;
            }
        } catch (error) {
            const executionError = getExecutionError(error);
            const [leftFailurePage, rightFailurePage] = await Promise.all([
                captureCurrentPage(left, leftAction.transition.from),
                captureCurrentPage(right, rightAction.transition.from),
            ]);
            const failureStep = await diagnoseSyncStep(
                steps + 1,
                leftFailurePage,
                rightFailurePage,
                event,
                executionError.leftError ?? executionError.rightError,
                {
                    leftBeforePage: leftAction.transition.from,
                    rightBeforePage: rightAction.transition.from,
                    leftEvent,
                    rightEvent,
                    leftActionStatus: rightMappingError
                        ? 'not-run'
                        : executionError.leftError ? 'failed' : 'succeeded',
                    rightActionStatus: executionError.rightError ? 'failed' : 'succeeded',
                    leftError: executionError.leftError,
                    rightError: executionError.rightError,
                }
            );
            await Promise.all([stopDevice(left.device), stopDevice(right.device)]);
            stepResults.push(failureStep);
            return finalize(createSyncResult(
                'failed',
                steps,
                leftFailurePage,
                rightFailurePage,
                stepResults,
                `Event execution failed: ${executionError.leftError ?? executionError.rightError}`,
                'EventFailure',
                steps + 1
            ));
        }

        steps += 1;
        currentLeftPage = leftAction.transition.to;
        currentRightPage = rightAction.transition.to;

        const after = await evaluatePagePair(left, right, currentLeftPage, currentRightPage, steps, event, {
            leftBeforePage: leftAction.transition.from,
            rightBeforePage: rightAction.transition.from,
            leftEvent,
            rightEvent,
            leftActionStatus: 'succeeded',
            rightActionStatus: 'succeeded',
        });
        currentLeftPage = after.leftPage;
        currentRightPage = after.rightPage;
        const stepResult = after.result;
        stepResults.push(stepResult);
        writeSyncResult(reportPath, createSyncResult(
            'running',
            steps,
            currentLeftPage,
            currentRightPage,
            stepResults,
            `Synchronized step ${steps} completed.`,
            'ExitEvent'
        ));
        const termination = pageCheckTermination(stepResult);
        if (termination) {
            await Promise.all([stopDevice(left.device), stopDevice(right.device)]);
            return finalize(createSyncResult(
                'failed',
                steps,
                currentLeftPage,
                currentRightPage,
                stepResults,
                termination === 'FunctionalMismatch' ? 'Functional page state diverged after synchronized execution.' : stepResult.operationPageCheck.reason,
                termination,
                termination === 'FunctionalMismatch' ? steps : undefined
            ));
        }
    }

    await Promise.all([stopDevice(left.device), stopDevice(right.device)]);
    return finalize(createSyncResult(
        'completed',
        steps,
        currentLeftPage,
        currentRightPage,
        stepResults,
        stopRequested
            ? 'Ctrl-C was handled as ExitEvent; synchronized execution completed.'
            : 'Synchronized execution completed.',
        'ExitEvent'
    ));
}
