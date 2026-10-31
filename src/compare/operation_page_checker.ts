import { Component } from '../model/component';
import { Page } from '../model/page';
import { HapTestLogger } from '../utils/logger';

export type OperationPageDecision = 'SAME_PAGE' | 'DIFFERENT_PAGE' | 'UNCERTAIN';

export interface LogicalComponentSummary {
    type: string;
    id?: string;
    key?: string;
    text?: string;
    hint?: string;
    interactive: boolean;
    publicLayout: boolean;
    parentTypes: string[];
}

export interface OperationPageSummary {
    valid: boolean;
    invalidReasons: string[];
    bundleName: string;
    abilityName: string;
    pagePath: string;
    rootType: string;
    titleCandidates: string[];
    semanticHeadings: string[];
    visibleTexts: string[];
    stableIds: string[];
    interactiveLabels: string[];
    businessTexts: string[];
    businessInteractiveLabels: string[];
    pageSpecificIds: string[];
    stablePageIds: string[];
    publicIds: string[];
    components: LogicalComponentSummary[];
    collection?: {
        deviceId?: string;
        screenSize?: string;
        screenshotPath?: string;
        source?: string;
    };
}

export type OperationPageDecisionSource = 'RULES' | 'COLLECTION';
export type OperationPageRule =
    | 'COLLECTION_INVALID'
    | 'BUNDLE_MISMATCH'
    | 'ABILITY_MISMATCH'
    | 'TITLE_CONFLICT'
    | 'TITLE_MATCH'
    | 'HEADING_CONFLICT'
    | 'BUSINESS_ROUTE_CONFLICT'
    | 'SHARED_PAGE_ANCHOR'
    | 'BUSINESS_ROUTE_MATCH'
    | 'IDENTITY_WITHOUT_SEMANTIC_ANCHOR'
    | 'INSUFFICIENT_EVIDENCE';
export interface OperationPageCheckResult {
    decision: OperationPageDecision;
    source: OperationPageDecisionSource;
    rule: OperationPageRule;
    reason: string;
    evidence: string[];
    unresolvedIssues: string[];
    leftPageSig: string;
    rightPageSig: string;
    leftSummary: OperationPageSummary;
    rightSummary: OperationPageSummary;
}

const logger = HapTestLogger.getLogger();

const SYSTEM_BUNDLES = new Set(['com.ohos.sceneboard', 'com.ohos.systemui', 'com.ohos.launcher']);
const MAX_SUMMARY_COMPONENTS = 120;
const INTERACTIVE_TYPES = new Set(['Button', 'TextInput', 'TextArea', 'SearchField', 'Checkbox', 'Radio', 'Switch', 'Slider', 'ListItem']);
const PUBLIC_LAYOUT_TOKENS = [
    'tab',
    'bottom',
    'navbar',
    'toolbar',
    'appbar',
    'titlebar',
    'menubar',
    'drawer',
    'sidebar',
    'searchbar',
    'locationbar',
];
const PUBLIC_CONTROL_ID_PATTERNS = [
    /tab(?:bar|page|navi|container|stack|title)/,
    /bottom/,
    /navbar|toolbar|appbar|titlebar|menubar|drawer|sidebar/,
    /searchbar|locationbar|search(?:box|field|input|icon|text)/,
    /backbutton|forwardbutton|refreshbutton|homebutton|homebtn|morebutton|closebutton|addbutton/,
];
const GENERIC_ID_WORDS = new Set([
    'root', 'main', 'page', 'navigation', 'nav', 'navi', 'stack', 'container', 'column', 'row', 'bar', 'toolbar',
    'menu', 'search', 'icon', 'button', 'back', 'forward', 'refresh', 'more', 'close', 'add', 'title',
    'header', 'content', 'area', 'field', 'holder', 'component', 'web', 'pc', 'tab', 'id', 'accessibility',
]);

function normalize(value: string): string { return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase(); }
function nonEmpty(value: string | undefined): string | undefined { const normalized = value?.trim(); return normalized || undefined; }
function words(value: string): string[] { return value.replace(/([a-z])([A-Z])/g, '$1 $2').toLocaleLowerCase().split(/[^a-z0-9]+/).filter(Boolean); }
function collectComponents(root: Component): Component[] {
    const result: Component[] = [];
    const visit = (component: Component, ancestorVisible: boolean): void => {
        const visible = ancestorVisible && component.visible !== false;
        if (!visible) return;
        result.push(component);
        for (const child of component.children ?? []) visit(child, visible);
    };
    visit(root, true);
    return result;
}
function isInteractive(component: Component): boolean { return component.hasUIEvent() || Boolean(component.clickable || component.longClickable || component.scrollable) || INTERACTIVE_TYPES.has(component.type ?? ''); }
function isTitleCandidate(component: Pick<Component, 'type' | 'id' | 'key'>): boolean {
    const type = normalize(component.type ?? '');
    const id = normalize(component.id ?? '');
    const key = normalize(component.key ?? '');
    return type === 'title' || type === 'heading' || id.includes('title') || id.includes('header') || key.includes('title') || key.includes('header');
}
function isLikelyGenericStableId(value: string): boolean {
    const idWords = words(value);
    return idWords.length === 0 || idWords.every((word) => GENERIC_ID_WORDS.has(word) || /^\d+$/.test(word));
}
function isStablePageId(value: string): boolean {
    const idWords = words(value);
    return idWords.length >= 2
        && idWords.includes('page')
        && idWords.some((word) => !GENERIC_ID_WORDS.has(word) && !/^\d+$/.test(word));
}
function isPublicLayoutComponent(component: LogicalComponentSummary): boolean {
    const identityValues = [component.id ?? '', component.key ?? ''];
    if (identityValues.some((value) => value && isStablePageId(value))) {
        return false;
    }
    const structuralValues = [component.type, ...component.parentTypes.slice(-3)];
    if (structuralValues.some((value) => {
        const compact = words(value).join('');
        return PUBLIC_LAYOUT_TOKENS.some((token) => compact.includes(token));
    })) {
        return true;
    }
    return identityValues.some((value) => {
        const compact = words(value).join('');
        return PUBLIC_CONTROL_ID_PATTERNS.some((pattern) => pattern.test(compact));
    });
}
function isSemanticHeading(component: LogicalComponentSummary): boolean {
    if (!component.text || component.interactive || component.publicLayout) {
        return false;
    }
    if (isTitleCandidate(component)) {
        return true;
    }
    const type = normalize(component.type);
    return component.parentTypes.length <= 8 && (type === 'text' || type === 'label' || type === 'heading') && normalize(component.text).length >= 2;
}
function summarizeComponents(page: Page): LogicalComponentSummary[] {
    return collectComponents(page.getRoot()).slice(0, MAX_SUMMARY_COMPONENTS).map((component) => {
        const parentTypes: string[] = [];
        let parent = component.parent;
        while (parent) { parentTypes.unshift(parent.type ?? ''); parent = parent.parent; }
        const summary: LogicalComponentSummary = { type: component.type ?? '', interactive: isInteractive(component), publicLayout: false, parentTypes };
        const values = { id: nonEmpty(component.id), key: nonEmpty(component.key), text: nonEmpty(component.text), hint: nonEmpty(component.hint) };
        if (values.id) summary.id = values.id;
        if (values.key) summary.key = values.key;
        if (values.text) summary.text = values.text;
        if (values.hint) summary.hint = values.hint;
        summary.publicLayout = isPublicLayoutComponent(summary);
        return summary;
    });
}
function emptySummary(): OperationPageSummary {
    return {
        valid: false,
        invalidReasons: ['Page was not collected.'],
        bundleName: '',
        abilityName: '',
        pagePath: '',
        rootType: '',
        titleCandidates: [],
        semanticHeadings: [],
        visibleTexts: [],
        stableIds: [],
        interactiveLabels: [],
        businessTexts: [],
        businessInteractiveLabels: [],
        pageSpecificIds: [],
        stablePageIds: [],
        publicIds: [],
        components: [],
        collection: { source: 'not_collected' },
    };
}
function buildSummary(page: Page | undefined, targetBundleName: string): OperationPageSummary {
    if (!page) return emptySummary();
    const bundleName = page.getBundleName().trim();
    const abilityName = page.getAbilityName().trim();
    const pagePath = page.getPagePath().trim();
    const rootType = page.getRoot().type?.trim() ?? '';
    const components = summarizeComponents(page);
    const titleCandidates = components.filter((item) => isTitleCandidate(item) && item.text).map((item) => normalize(item.text!));
    const semanticHeadings = components.filter((item) => isSemanticHeading(item)).map((item) => normalize(item.text!));
    const visibleTexts = components.filter((item) => item.text).map((item) => normalize(item.text!));
    const stableIds = components.flatMap((item) => [item.id, item.key]).filter((item): item is string => Boolean(item)).map(normalize);
    const interactiveLabels = components.filter((item) => item.interactive).flatMap((item) => [item.text, item.hint, item.id, item.key]).filter((item): item is string => Boolean(item)).map(normalize);
    const businessTexts = components.filter((item) => item.text && (!item.publicLayout || isTitleCandidate(item))).map((item) => normalize(item.text!)).filter((item) => item.length >= 2);
    const businessInteractiveLabels = components.filter((item) => item.interactive && !item.publicLayout).flatMap((item) => [item.text, item.hint, item.id, item.key]).filter((item): item is string => Boolean(item)).map(normalize);
    const pageSpecificIds = components.filter((item) => !item.publicLayout).flatMap((item) => [item.id, item.key]).filter((item): item is string => Boolean(item)).filter((item) => !isLikelyGenericStableId(item)).map(normalize);
    const stablePageIds = components.filter((item) => !item.publicLayout).flatMap((item) => [item.id, item.key]).filter((item): item is string => Boolean(item)).filter(isStablePageId).map(normalize);
    const publicIds = components.filter((item) => item.publicLayout).flatMap((item) => [item.id, item.key]).filter((item): item is string => Boolean(item)).map(normalize);
    const invalidReasons: string[] = [];
    if (!bundleName) invalidReasons.push('bundleName is missing.');
    if (bundleName && bundleName !== targetBundleName) invalidReasons.push(`bundleName=${bundleName} is not target bundle=${targetBundleName}.`);
    if (SYSTEM_BUNDLES.has(bundleName)) invalidReasons.push(`System bundle ${bundleName} is not an application page.`);
    if (rootType === 'WindowScene' && bundleName !== targetBundleName) invalidReasons.push('WindowScene belongs to a non-target window.');
    if (page.isStop() || page.isBackground()) invalidReasons.push('Page represents STOP or BACKGROUND state.');
    if (components.length === 0) invalidReasons.push('ViewTree has no components.');
    if (components.some((component) => component.type === 'UIExtensionComponent')) invalidReasons.push('ViewTree contains a visible UIExtensionComponent; the foreground may be an external system window or picker.');
    if (!abilityName && !pagePath && titleCandidates.length === 0 && semanticHeadings.length === 0 && stableIds.length === 0 && interactiveLabels.length === 0) invalidReasons.push('No page identity or semantic anchors are available.');
    const snapshot = page.getSnapshot();
    return { valid: invalidReasons.length === 0, invalidReasons, bundleName, abilityName, pagePath, rootType, titleCandidates: [...new Set(titleCandidates)], semanticHeadings: [...new Set(semanticHeadings)], visibleTexts: [...new Set(visibleTexts)], stableIds: [...new Set(stableIds)], interactiveLabels: [...new Set(interactiveLabels)], businessTexts: [...new Set(businessTexts)], businessInteractiveLabels: [...new Set(businessInteractiveLabels)], pageSpecificIds: [...new Set(pageSpecificIds)], stablePageIds: [...new Set(stablePageIds)], publicIds: [...new Set(publicIds)], components, collection: { deviceId: snapshot?.udid, screenSize: snapshot ? `${snapshot.screenWidth}x${snapshot.screenHeight}` : undefined, screenshotPath: snapshot?.screenCapPath, source: 'page_snapshot' } };
}
function intersection(left: string[], right: string[]): string[] { const rightSet = new Set(right); return [...new Set(left.filter((value) => rightSet.has(value)))]; }
function sameNonEmpty(left: string, right: string): boolean { return Boolean(left && right && normalize(left) === normalize(right)); }
function ruleResult(decision: OperationPageDecision, source: OperationPageDecisionSource, rule: OperationPageRule, reason: string, evidence: string[] = [], unresolvedIssues: string[] = []) { return { decision, source, rule, reason, evidence, unresolvedIssues }; }
function checkRules(left: OperationPageSummary, right: OperationPageSummary) {
    if (!left.valid || !right.valid) return ruleResult('UNCERTAIN', 'COLLECTION', 'COLLECTION_INVALID', 'One or both pages could not be validated as target application pages.', [], [...left.invalidReasons.map((item) => `left: ${item}`), ...right.invalidReasons.map((item) => `right: ${item}`)]);
    if (left.bundleName !== right.bundleName) return ruleResult('DIFFERENT_PAGE', 'RULES', 'BUNDLE_MISMATCH', 'The validated pages belong to different application bundles.', [`left bundle=${left.bundleName}`, `right bundle=${right.bundleName}`]);
    const abilityMismatch = Boolean(left.abilityName && right.abilityName && !sameNonEmpty(left.abilityName, right.abilityName));
    const abilityEvidence = abilityMismatch ? [`left ability=${left.abilityName}`, `right ability=${right.abilityName}`] : [];
    const sharedTitles = intersection(left.titleCandidates, right.titleCandidates);
    const sharedSemanticHeadings = intersection(left.semanticHeadings, right.semanticHeadings);
    const sharedPageSpecificIds = intersection(left.pageSpecificIds, right.pageSpecificIds);
    const sharedStablePageIds = intersection(left.stablePageIds, right.stablePageIds);
    const sharedBusinessInteractiveLabels = intersection(left.businessInteractiveLabels, right.businessInteractiveLabels);
    const sharedBusinessTexts = intersection(left.businessTexts, right.businessTexts);
    if (left.titleCandidates.length > 0 && right.titleCandidates.length > 0 && sharedTitles.length === 0 && sharedStablePageIds.length === 0) return ruleResult('DIFFERENT_PAGE', 'RULES', 'TITLE_CONFLICT', 'The pages expose conflicting semantic title evidence without a shared stable page identity.', [`left titles=${left.titleCandidates.join(', ')}`, `right titles=${right.titleCandidates.join(', ')}`]);
    if (sharedTitles.length > 0 && (sharedStablePageIds.length > 0 || sharedPageSpecificIds.length > 0 || sharedBusinessInteractiveLabels.length > 0 || sameNonEmpty(left.pagePath, right.pagePath))) return ruleResult('SAME_PAGE', 'RULES', 'TITLE_MATCH', abilityMismatch ? 'Both pages share semantic title evidence and compatible page anchors despite different Ability entry points.' : 'Both pages share semantic title evidence and compatible page anchors.', [`shared titles=${sharedTitles.join(', ')}`, ...abilityEvidence]);
    if (left.semanticHeadings.length > 0 && right.semanticHeadings.length > 0 && sharedSemanticHeadings.length === 0 && sharedStablePageIds.length === 0) return ruleResult('DIFFERENT_PAGE', 'RULES', 'HEADING_CONFLICT', 'The pages expose conflicting semantic heading evidence without a shared stable page identity.', [`left headings=${left.semanticHeadings.join(', ')}`, `right headings=${right.semanticHeadings.join(', ')}`]);
    const leftMeaningfulBusinessTexts = left.businessTexts.filter((value) => value.length >= 2);
    const rightMeaningfulBusinessTexts = right.businessTexts.filter((value) => value.length >= 2);
    if (!sameNonEmpty(left.pagePath, right.pagePath) && left.pagePath && right.pagePath && leftMeaningfulBusinessTexts.length > 0 && rightMeaningfulBusinessTexts.length > 0 && sharedBusinessTexts.length === 0 && left.stablePageIds.length > 0 && right.stablePageIds.length > 0 && sharedStablePageIds.length === 0) return ruleResult('DIFFERENT_PAGE', 'RULES', 'BUSINESS_ROUTE_CONFLICT', 'The pages have different routes, non-overlapping business text, and conflicting stable page identities; public layout and ordinary controls are insufficient to establish the same page.', [`left pagePath=${left.pagePath}`, `right pagePath=${right.pagePath}`, `left businessTexts=${leftMeaningfulBusinessTexts.join(', ')}`, `right businessTexts=${rightMeaningfulBusinessTexts.join(', ')}`, `left stablePageIds=${left.stablePageIds.join(', ')}`, `right stablePageIds=${right.stablePageIds.join(', ')}`, `shared publicIds=${intersection(left.publicIds, right.publicIds).join(', ') || '<none>'}`]);
    const sharedSemanticAnchors = [...sharedBusinessTexts, ...sharedBusinessInteractiveLabels, ...sharedTitles, ...sharedSemanticHeadings];
    if (sharedStablePageIds.length > 0 && sharedSemanticAnchors.length > 0) return ruleResult('SAME_PAGE', 'RULES', 'SHARED_PAGE_ANCHOR', 'Both pages share a stable logical page identity and at least one matching business or semantic anchor; route, layout, and dynamic content differences are tolerated.', [`shared stable page ids=${sharedStablePageIds.join(', ')}`, `shared semantic anchors=${[...new Set(sharedSemanticAnchors)].join(', ')}`]);
    if (sharedBusinessTexts.length > 0 && sameNonEmpty(left.pagePath, right.pagePath)) return ruleResult('SAME_PAGE', 'RULES', 'BUSINESS_ROUTE_MATCH', abilityMismatch ? 'The pages share business-visible content and the same route identity despite different Ability entry points.' : 'The pages share business-visible content and the same route identity.', [`shared business text=${sharedBusinessTexts.join(', ')}`, ...abilityEvidence]);
    if (abilityMismatch) return ruleResult('UNCERTAIN', 'RULES', 'ABILITY_MISMATCH', 'The pages expose different Ability entry points, but the available page evidence does not establish either a shared logical page or a page divergence.', abilityEvidence, ['Ability identity is an entry-point signal and is not sufficient by itself to classify the operation pages.']);
    if (sameNonEmpty(left.bundleName, right.bundleName) && sameNonEmpty(left.abilityName, right.abilityName) && sameNonEmpty(left.pagePath, right.pagePath) && left.titleCandidates.length === 0 && right.titleCandidates.length === 0 && left.businessInteractiveLabels.length === 0 && right.businessInteractiveLabels.length === 0) return ruleResult('UNCERTAIN', 'RULES', 'IDENTITY_WITHOUT_SEMANTIC_ANCHOR', 'Package, Ability, and route match, but no reliable page identity or business semantic correspondence proves the same operation page.', [`bundle=${left.bundleName}`, `ability=${left.abilityName}`, `pagePath=${left.pagePath}`, `shared public ids=${intersection(left.publicIds, right.publicIds).join(', ') || '<none>'}`], ['Public navigation or common controls cannot establish SAME_PAGE.']);
    return ruleResult('UNCERTAIN', 'RULES', 'INSUFFICIENT_EVIDENCE', 'Available page identities and business semantic anchors are insufficient for a deterministic decision.', [], ['Page route or business semantic evidence is incomplete or conflicting.']);
}
function pageSignature(page: Page | undefined): string { return page?.getContentSig() ?? ''; }
function diagnosticSummary(summary: OperationPageSummary): Record<string, unknown> {
    return {
        collection: summary.collection,
        bundleName: summary.bundleName,
        abilityName: summary.abilityName,
        pagePath: summary.pagePath,
        titleCandidates: summary.titleCandidates,
        visibleTexts: summary.visibleTexts,
        stableIds: summary.stableIds,
        interactiveLabels: summary.interactiveLabels,
        businessTexts: summary.businessTexts,
        businessInteractiveLabels: summary.businessInteractiveLabels,
        pageSpecificIds: summary.pageSpecificIds,
        stablePageIds: summary.stablePageIds,
        publicIds: summary.publicIds,
        invalidReasons: summary.invalidReasons,
    };
}

export class OperationPageChecker {
    constructor(private readonly options: { targetBundleName: string }) {}

    summarize(page: Page | undefined): OperationPageSummary {
        return buildSummary(page, this.options.targetBundleName);
    }

    checkRules(leftPage: Page | undefined, rightPage: Page | undefined): OperationPageCheckResult {
        const leftSummary = this.summarize(leftPage);
        const rightSummary = this.summarize(rightPage);
        const result = {
            ...checkRules(leftSummary, rightSummary),
            leftPageSig: pageSignature(leftPage),
            rightPageSig: pageSignature(rightPage),
            leftSummary,
            rightSummary,
        };
        logger.debug(`[operation-page-check] rules=${JSON.stringify({ left: diagnosticSummary(leftSummary), right: diagnosticSummary(rightSummary), rule: result.rule, decision: result.decision, source: result.source, reason: result.reason, evidence: result.evidence, unresolvedIssues: result.unresolvedIssues })}`);
        return result;
    }
}

export function checkOperationPages(
    leftPage: Page,
    rightPage: Page,
    targetBundleName = leftPage.getBundleName().trim()
): OperationPageCheckResult {
    return new OperationPageChecker({ targetBundleName }).checkRules(leftPage, rightPage);
}
