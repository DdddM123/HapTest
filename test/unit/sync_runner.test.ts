import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { compareSyncPages, diagnoseSyncStep, mapEventToPage, writeSyncMarkdownReport } from '../../src/runner/sync_runner';
import { Component } from '../../src/model/component';
import { Page } from '../../src/model/page';
import { ViewTree } from '../../src/model/viewtree';
import { TouchEvent } from '../../src/event/ui_event';

function createPage(text: string, titleText = 'Home'): Page {
    const root = new Component();
    root.type = 'Root';
    root.key = 'root';
    root.text = text;
    root.bounds = [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
    ];
    const title = new Component();
    title.type = 'Text';
    title.id = 'page-title';
    title.text = titleText;
    title.parent = root;
    root.addChild(title);
    return new Page(new ViewTree(root), 'MainAbility', 'com.example.demo', 'pages/Home');
}

describe('compareSyncPages', () => {
    it('reports consistent for identical pages', () => {
        const left = createPage('same');
        const right = createPage('same');

        const result = compareSyncPages(left, right);

        expect(result.consistent).toBe(true);
        expect(result.leftPageSig).toBe(result.rightPageSig);
    });

    it('reports inconsistent when page signatures differ', () => {
        const left = createPage('left');
        const right = createPage('right');

        const result = compareSyncPages(left, right);

        expect(result.consistent).toBe(false);
        expect(result.leftPageSig).not.toBe(result.rightPageSig);
    });
});

describe('diagnoseSyncStep', () => {
    it('reports component text differences with page context', async () => {
        const left = createPage('left');
        const right = createPage('right');

        const result = await diagnoseSyncStep(1, left, right);

        expect(result.consistent).toBe(true);
        expect(result.pageMatched).toBe(true);
        expect(result.uiConsistent).toBe(false);
        expect(result.leftActionStatus).toBe('not-run');
        expect(result.rightActionStatus).toBe('not-run');
        expect(result.leftBeforePagePath).toBe('pages/Home');
        expect(result.rightBeforePagePath).toBe('pages/Home');
        expect(result.leftPagePath).toBe('pages/Home');
        expect(result.componentDiffs.some((issue) => issue.diffs.textDiffs.some((diff) => diff.field === 'text'))).toBe(true);
    });

    it('keeps screenshot paths from page snapshots in component diffs', async () => {
        const left = createPage('left');
        const right = createPage('right');
        left.setSnapshot({ screenCapPath: '/tmp/mobile.png' } as any);
        right.setSnapshot({ screenCapPath: '/tmp/two-in-one.png' } as any);

        const result = await diagnoseSyncStep(1, left, right);
        const textDiff = result.componentDiffs.find((issue) => issue.diffs.textDiffs.some((diff) => diff.field === 'text'));

        expect(textDiff?.mobileScreenshot).toBe('/tmp/mobile.png');
        expect(textDiff?.twoInOneScreenshot).toBe('/tmp/two-in-one.png');
    });

    it('reports different page identities as functional issues', async () => {
        const left = createPage('same');
        const settings = createPage('same', 'Settings');
        const right = new Page(new ViewTree(settings.getRoot()), 'MainAbility', 'com.example.demo', 'pages/Settings');

        const result = await diagnoseSyncStep(0, left, right);

        expect(result.functionalIssues.some((issue) => issue.kind === 'page-identity-mismatch')).toBe(true);
    });

    it('uses the same logical page rules initially and after an event without hiding UI differences', async () => {
        const left = createPage('same');
        const adapted = createPage('same');
        adapted.getRoot().bounds = [{ x: 0, y: 0 }, { x: 300, y: 200 }];
        const right = new Page(new ViewTree(adapted.getRoot()), 'DesktopAbility', 'com.example.demo', 'pages/Home');
        const initial = await diagnoseSyncStep(0, left, right);
        const afterEvent = await diagnoseSyncStep(1, left, right, new TouchEvent({ x: 20, y: 20 }));

        for (const result of [initial, afterEvent]) {
            expect(result.operationPageCheck.decision).toBe('SAME_PAGE');
            expect(result.operationPageCheck.rule).toBe('TITLE_MATCH');
            expect(result.pageMatched).toBe(true);
            expect(result.consistent).toBe(true);
            expect(result.uiConsistent).toBe(false);
            expect(result.functionalIssues).toEqual([]);
            expect(result.componentDiffs.length).toBeGreaterThan(0);
        }
    });

    it('does not label an uncertain page relationship as a confirmed identity mismatch', async () => {
        const root = new Component();
        root.type = 'Root';
        const left = new Page(new ViewTree(root), 'MobileAbility', 'com.example.demo', 'pages/Home');
        const right = new Page(new ViewTree(root), 'DesktopAbility', 'com.example.demo', 'pages/Home');
        const result = await diagnoseSyncStep(0, left, right);

        expect(result.operationPageCheck.decision).toBe('UNCERTAIN');
        expect(result.consistent).toBe(false);
        expect(result.pageMatched).toBe(false);
        expect(result.functionalIssues).toEqual([]);
    });
});

describe('writeSyncMarkdownReport', () => {
    it('writes only issue steps with relative screenshot links', () => {
        const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'haptest-sync-report-'));
        const reportPath = path.join(outputDir, 'sync-result.json');
        const result = {
            status: 'completed',
            consistent: true,
            uiConsistent: false,
            steps: 1,
            leftPageSig: 'left',
            rightPageSig: 'right',
            termination: 'ExitEvent',
            stepResults: [
                {
                    step: 0,
                    leftActionStatus: 'not-run',
                    rightActionStatus: 'not-run',
                    leftBeforePageSig: 'left',
                    rightBeforePageSig: 'right',
                    leftBeforePagePath: 'pages/Home',
                    rightBeforePagePath: 'pages/Home',
                    leftPageSig: 'left',
                    rightPageSig: 'right',
                    leftPagePath: 'pages/Home',
                    rightPagePath: 'pages/Home',
                    consistent: true,
                    pageMatched: true,
                    uiConsistent: false,
                    componentDiffs: [{
                        pageIndex: 0,
                        componentName: 'text:Title',
                        parentName: 'type:Column',
                        mobileScreenshot: path.join(outputDir, 'left.png'),
                        twoInOneScreenshot: path.join(outputDir, 'right.png'),
                        diffs: {
                            structuralDiffs: [{ field: 'bounds', mobileValue: '1', twoInOneValue: '2' }],
                            statusDiffs: [],
                            textDiffs: [],
                        },
                    }],
                    functionalIssues: [],
                },
                {
                    step: 1,
                    leftActionStatus: 'succeeded',
                    rightActionStatus: 'succeeded',
                    leftBeforePageSig: 'left',
                    rightBeforePageSig: 'right',
                    leftBeforePagePath: 'pages/Home',
                    rightBeforePagePath: 'pages/Home',
                    leftPageSig: 'left',
                    rightPageSig: 'right',
                    leftPagePath: 'pages/Home',
                    rightPagePath: 'pages/Home',
                    consistent: true,
                    pageMatched: true,
                    uiConsistent: true,
                    componentDiffs: [],
                    functionalIssues: [],
                },
            ],
        } as any;

        const markdownPath = writeSyncMarkdownReport(reportPath, result);
        const markdown = fs.readFileSync(markdownPath, 'utf-8');

        expect(markdown).toContain('## Step 0');
        expect(markdown).not.toContain('## Step 1');
        expect(markdown).toContain('left.png');
        expect(markdown).toContain('right.png');
        expect(markdown).toContain('layout or structure (1 issue)');
        expect(markdown).not.toContain('mobile=`1`');
    });
});

describe('mapEventToPage', () => {
    it('maps a component action to the matching component on the other page', () => {
        const leftRoot = new Component();
        leftRoot.type = 'Root';
        leftRoot.bounds = [{ x: 0, y: 0 }, { x: 100, y: 100 }];
        const leftButton = new Component();
        leftButton.type = 'Button';
        leftButton.text = '开始辅助操作';
        leftButton.bounds = [{ x: 10, y: 10 }, { x: 30, y: 30 }];
        leftRoot.addChild(leftButton);

        const rightRoot = new Component();
        rightRoot.type = 'Root';
        rightRoot.bounds = [{ x: 0, y: 0 }, { x: 200, y: 200 }];
        const rightButton = new Component();
        rightButton.type = 'Button';
        rightButton.text = '开始辅助操作';
        rightButton.bounds = [{ x: 120, y: 140 }, { x: 180, y: 180 }];
        rightRoot.addChild(rightButton);

        const mapped = mapEventToPage(
            new TouchEvent(leftButton),
            new Page(new ViewTree(leftRoot), 'MainAbility', 'com.example.demo', 'pages/Home'),
            new Page(new ViewTree(rightRoot), 'MainAbility', 'com.example.demo', 'pages/Home')
        );

        expect(mapped.toJson().point).toEqual({ x: 150, y: 160 });
    });
});
