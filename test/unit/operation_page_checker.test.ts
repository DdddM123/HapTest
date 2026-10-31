import { describe, expect, it } from 'vitest';
import { Component } from '../../src/model/component';
import { Page } from '../../src/model/page';
import { ViewTree } from '../../src/model/viewtree';
import { checkOperationPages, OperationPageChecker } from '../../src/compare/operation_page_checker';

interface PageOptions {
    ability?: string;
    bundle?: string;
    path?: string;
    title?: string;
    businessText?: string;
    action?: string;
    pageId?: string;
    adapted?: boolean;
}

function createPage(options: PageOptions = {}): Page {
    const root = new Component();
    root.type = 'Root';
    root.bounds = [{ x: 0, y: 0 }, { x: options.adapted ? 1600 : 800, y: 1000 }];
    root.id = options.pageId;
    let content = root;
    if (options.adapted) {
        content = Object.assign(new Component(), { type: 'Stack', parent: root });
        root.addChild(content);
        content.addChild(Object.assign(new Component(), { type: 'Image', parent: content }));
    }
    const values: Array<Partial<Component>> = [
        { type: 'Text', id: 'page-title', text: options.title },
        { type: 'Paragraph', text: options.businessText },
        { type: 'Button', id: 'primary-action', text: options.action, clickable: true, enabled: true },
    ];
    for (const value of values) {
        if (!value.text) continue;
        const component = Object.assign(new Component(), value, {
            parent: content,
            bounds: [{ x: options.adapted ? 400 : 20, y: 100 }, { x: options.adapted ? 800 : 200, y: 160 }],
        });
        content.addChild(component);
    }
    return new Page(new ViewTree(root), options.ability ?? 'EntryAbility', options.bundle ?? 'com.example.demo', options.path ?? 'pages/MainPage');
}

describe('operation-page rules migrated from main', () => {
    it('matches equal runtime identities supported by semantic page evidence', () => {
        const result = checkOperationPages(createPage({ title: 'Overview' }), createPage({ title: 'Overview' }));
        expect(result.decision).toBe('SAME_PAGE');
        expect(result.rule).toBe('TITLE_MATCH');
    });

    it('accepts different Abilities with a shared route and semantic evidence and preserves Ability evidence', () => {
        const result = checkOperationPages(
            createPage({ ability: 'EntryAbility', title: 'Overview' }),
            createPage({ ability: 'PcAbility', title: 'Overview', adapted: true }),
        );
        expect(result.decision).toBe('SAME_PAGE');
        expect(result.evidence).toContain('left ability=EntryAbility');
        expect(result.evidence).toContain('right ability=PcAbility');
        expect(result.leftPageSig).not.toBe(result.rightPageSig);
    });

    it('uses shared business text plus route even without an explicit title', () => {
        const result = checkOperationPages(
            createPage({ businessText: 'Current conditions' }),
            createPage({ ability: 'DesktopAbility', businessText: 'Current conditions', adapted: true }),
        );
        expect(result.decision).toBe('SAME_PAGE');
        expect(result.rule).toBe('BUSINESS_ROUTE_MATCH');
    });

    it('tolerates component counts, coordinates, and hierarchy differences', () => {
        const left = createPage({ title: 'Overview', action: 'View forecast' });
        const right = createPage({ title: 'Overview', action: 'View forecast', adapted: true });
        expect(left.getComponents().length).not.toBe(right.getComponents().length);
        expect(checkOperationPages(left, right).decision).toBe('SAME_PAGE');
    });

    it('allows different routes when stable page identity and semantic anchors correspond', () => {
        const result = checkOperationPages(
            createPage({ pageId: 'overviewPage', title: 'Overview', path: 'pages/MainPage' }),
            createPage({ pageId: 'overviewPage', title: 'Overview', path: 'desktop/Dashboard', adapted: true }),
        );
        expect(result.decision).toBe('SAME_PAGE');
    });

    it('retains the shared-page-anchor rule for matching business content on different routes', () => {
        const result = checkOperationPages(
            createPage({ pageId: 'overviewPage', businessText: 'Current conditions' }),
            createPage({ pageId: 'overviewPage', businessText: 'Current conditions', path: 'desktop/Dashboard' }),
        );
        expect(result.decision).toBe('SAME_PAGE');
        expect(result.rule).toBe('SHARED_PAGE_ANCHOR');
    });

    it('does not infer divergence from different routes alone', () => {
        expect(checkOperationPages(createPage(), createPage({ path: 'desktop/Dashboard' })).decision).toBe('UNCERTAIN');
    });

    it('detects different business pages even when all three runtime identity fields match', () => {
        const result = checkOperationPages(createPage({ title: 'Overview' }), createPage({ title: 'Preferences' }));
        expect(result.decision).toBe('DIFFERENT_PAGE');
        expect(result.rule).toBe('TITLE_CONFLICT');
    });

    it('does not let differing Abilities hide conflicting business page identities', () => {
        const result = checkOperationPages(
            createPage({ title: 'Overview' }),
            createPage({ title: 'Preferences', ability: 'DesktopAbility', path: 'pages/Preferences' }),
        );
        expect(result.decision).toBe('DIFFERENT_PAGE');
    });

    it('retains heading conflicts for untitled pages', () => {
        const left = createPage();
        const right = createPage();
        for (const [page, text] of [[left, 'Recent activity'], [right, 'Account details']] as const) {
            page.getRoot().addChild(Object.assign(new Component(), { type: 'Text', text, parent: page.getRoot() }));
        }
        expect(checkOperationPages(left, right).rule).toBe('HEADING_CONFLICT');
        expect(checkOperationPages(left, right).decision).toBe('DIFFERENT_PAGE');
    });

    it('keeps differing Abilities uncertain without semantic correspondence', () => {
        const result = checkOperationPages(createPage(), createPage({ ability: 'DesktopAbility' }));
        expect(result.decision).toBe('UNCERTAIN');
        expect(result.rule).toBe('ABILITY_MISMATCH');
    });

    it('does not treat equal runtime identities without semantic evidence as a proof', () => {
        const result = checkOperationPages(createPage(), createPage());
        expect(result.decision).toBe('UNCERTAIN');
        expect(result.rule).toBe('IDENTITY_WITHOUT_SEMANTIC_ANCHOR');
    });

    it('does not use shared public navigation alone to establish SAME_PAGE', () => {
        const left = createPage();
        const right = createPage();
        for (const page of [left, right]) {
            const toolbar = Object.assign(new Component(), { type: 'Toolbar', id: 'toolbar', parent: page.getRoot() });
            toolbar.addChild(Object.assign(new Component(), { type: 'Button', id: 'homeButton', text: 'Home', clickable: true, parent: toolbar }));
            page.getRoot().addChild(toolbar);
        }
        expect(checkOperationPages(left, right).decision).toBe('UNCERTAIN');
    });

    it('excludes hidden nodes and their children from page semantics', () => {
        const left = createPage({ title: 'Overview' });
        const right = createPage({ title: 'Overview' });
        const hidden = Object.assign(new Component(), { type: 'Column', visible: false, parent: right.getRoot() });
        hidden.addChild(Object.assign(new Component(), { type: 'Text', id: 'header', text: 'Preferences', parent: hidden }));
        right.getRoot().addChild(hidden);
        const result = checkOperationPages(left, right);
        expect(result.decision).toBe('SAME_PAGE');
        expect(result.rightSummary.visibleTexts).not.toContain('preferences');
    });

    it('marks system windows, wrong bundles, and missing pages as collection failures', () => {
        const checker = new OperationPageChecker({ targetBundleName: 'com.example.demo' });
        for (const invalid of [undefined, createPage({ bundle: 'com.ohos.sceneboard' }), createPage({ bundle: 'com.example.other' })]) {
            const result = checker.checkRules(createPage({ title: 'Overview' }), invalid);
            expect(result.decision).toBe('UNCERTAIN');
            expect(result.source).toBe('COLLECTION');
            expect(result.rule).toBe('COLLECTION_INVALID');
        }
    });

    it('validates both pages against the expected target rather than accepting a shared unrelated bundle', () => {
        const result = checkOperationPages(
            createPage({ bundle: 'com.example.other', title: 'Overview' }),
            createPage({ bundle: 'com.example.other', title: 'Overview' }),
            'com.example.demo',
        );
        expect(result.decision).toBe('UNCERTAIN');
        expect(result.source).toBe('COLLECTION');
    });

    it('preserves the reference route-conflict rule only with disjoint stable page identities and business evidence', () => {
        const result = checkOperationPages(
            createPage({ pageId: 'activityPage', businessText: 'Recent activity', path: 'pages/Activity' }),
            createPage({ pageId: 'accountPage', businessText: 'Account details', path: 'pages/Account' }),
        );
        expect(result.decision).toBe('DIFFERENT_PAGE');
        expect(result.rule).toBe('BUSINESS_ROUTE_CONFLICT');
    });
});
