import { Page } from '../../model/page';
import { Component } from '../../model/component';
import { Point } from '../../model/point';
import {
    AiComponentMatcher,
    buildComponentParentMap,
    ComponentWithParent,
    matchComponentParentMaps,
} from '../component_matcher';
import { CompareComponentDiffGroups, CompareComponentDiffIssue, CompareComponentFieldDiff } from '../types';
import { HapTestLogger } from '../../utils/logger';

const logger = HapTestLogger.getLogger();

const COMPARABLE_FIELDS: Array<keyof ComparableComponentFields> = [
    'type',
    'id',
    'key',
    'name',
    'text',
    'hint',
    'checkable',
    'checked',
    'clickable',
    'enabled',
    'focused',
    'longClickable',
    'scrollable',
    'selected',
    'visible',
    'debugLine',
    'bounds',
    'origBounds',
];

interface ComparableComponentFields {
    type?: string;
    id?: string;
    key?: string;
    name?: string;
    text?: string;
    hint?: string;
    checkable?: boolean;
    checked?: boolean;
    clickable?: boolean;
    enabled?: boolean;
    focused?: boolean;
    longClickable?: boolean;
    scrollable?: boolean;
    selected?: boolean;
    visible?: boolean;
    debugLine?: string;
    bounds?: string;
    origBounds?: string;
}

export async function detectComponentDiffIssues(
    pageIndex: number,
    mobilePage: Page,
    twoInOnePage: Page,
    mobileScreenshot: string,
    twoInOneScreenshot: string,
    aiMatcher?: AiComponentMatcher,
    aiOnlyMatch = false
): Promise<CompareComponentDiffIssue[]> {
    const mobileParentMap = buildComponentParentMap(mobilePage);
    const twoInOneParentMap = buildComponentParentMap(twoInOnePage);
    const matchedGroups = await matchComponentParentMaps(mobileParentMap, twoInOneParentMap, aiMatcher, { aiOnly: aiOnlyMatch });

    let matchedComponentCount = 0;
    let aiMatchedCount = 0;
    for (const group of matchedGroups) {
        const mobileComponents = group.mobileComponents;
        const twoInOneComponents = group.twoInOneComponents;
        matchedComponentCount += Math.min(mobileComponents.length, twoInOneComponents.length);
        if (group.aiMatched) {
            aiMatchedCount += 1;
        }
    }
    const aiLog = aiMatcher ? ` (ai-matched: ${aiMatchedCount})` : '';
    logger.info(`[diff] Matched components: ${matchedComponentCount}${aiLog} (pageIndex=${pageIndex})`);

    const issues: CompareComponentDiffIssue[] = [];
    for (const group of matchedGroups) {
        const mobileComponents = group.mobileComponents;
        const twoInOneComponents = group.twoInOneComponents;
        const pairCount = Math.min(mobileComponents.length, twoInOneComponents.length);
        for (let index = 0; index < pairCount; index += 1) {
            const mobileComponent = mobileComponents[index];
            const twoInOneComponent = twoInOneComponents[index];
            const fieldDiffs = collectFieldDiffs(mobileComponent, twoInOneComponent);
            if (fieldDiffs.length === 0) {
                continue;
            }
            issues.push({
                pageIndex,
                componentName: mobileComponent.componentName,
                parentName: mobileComponent.parentName,
                mobileScreenshot,
                twoInOneScreenshot,
                diffs: groupFieldDiffs(fieldDiffs),
            });
        }
    }
    issues.push(...detectUnmatchedInteractiveComponents(
        pageIndex,
        mobileParentMap,
        twoInOneParentMap,
        mobileScreenshot,
        twoInOneScreenshot,
        matchedGroups
    ));
    return issues;
}

function detectUnmatchedInteractiveComponents(
    pageIndex: number,
    mobileParentMap: Map<string, ComponentWithParent[]>,
    twoInOneParentMap: Map<string, ComponentWithParent[]>,
    mobileScreenshot: string,
    twoInOneScreenshot: string,
    matchedGroups: Array<{ mobileKey: string; twoInOneKey: string; mobileComponents: ComponentWithParent[]; twoInOneComponents: ComponentWithParent[] }>
): CompareComponentDiffIssue[] {
    const matchedMobile = new Set<Component>();
    const matchedTwoInOne = new Set<Component>();
    for (const group of matchedGroups) {
        const pairCount = Math.min(group.mobileComponents.length, group.twoInOneComponents.length);
        for (let index = 0; index < pairCount; index += 1) {
            matchedMobile.add(group.mobileComponents[index].component);
            matchedTwoInOne.add(group.twoInOneComponents[index].component);
        }
    }

    const issues: CompareComponentDiffIssue[] = [];
    const allKeys = new Set([...mobileParentMap.keys(), ...twoInOneParentMap.keys()]);
    for (const key of allKeys) {
        const mobileComponents = mobileParentMap.get(key) ?? [];
        const twoInOneComponents = twoInOneParentMap.get(key) ?? [];
        const mobileExtras = mobileComponents.filter((item) => isInteractive(item.component) && !matchedMobile.has(item.component));
        const twoInOneExtras = twoInOneComponents.filter((item) => isInteractive(item.component) && !matchedTwoInOne.has(item.component));
        const difference = mobileExtras.length - twoInOneExtras.length;
        if (difference === 0) {
            continue;
        }
        if (difference > 0) {
            for (const item of mobileExtras.slice(twoInOneExtras.length)) {
                issues.push(buildPresenceIssue(
                    pageIndex,
                    item,
                    'present',
                    'missing',
                    mobileScreenshot,
                    twoInOneScreenshot
                ));
            }
        } else {
            for (const item of twoInOneExtras.slice(mobileExtras.length)) {
                issues.push(buildPresenceIssue(
                    pageIndex,
                    item,
                    'missing',
                    'present',
                    mobileScreenshot,
                    twoInOneScreenshot
                ));
            }
        }
    }
    return issues;
}

function buildPresenceIssue(
    pageIndex: number,
    item: ComponentWithParent,
    mobileValue: string,
    twoInOneValue: string,
    mobileScreenshot: string,
    twoInOneScreenshot: string
): CompareComponentDiffIssue {
    return {
        pageIndex,
        componentName: item.componentName,
        parentName: item.parentName,
        mobileScreenshot,
        twoInOneScreenshot,
        diffs: {
            structuralDiffs: [{ field: 'interactive-component-presence', mobileValue, twoInOneValue }],
            statusDiffs: [],
            textDiffs: [],
        },
    };
}

function groupFieldDiffs(fieldDiffs: CompareComponentFieldDiff[]): CompareComponentDiffGroups {
    const grouped: CompareComponentDiffGroups = {
        structuralDiffs: [],
        statusDiffs: [],
        textDiffs: [],
    };

    for (const diff of fieldDiffs) {
        const group = classifyDiffField(diff.field);
        if (group === 'structural') {
            grouped.structuralDiffs.push(diff);
            continue;
        }
        if (group === 'status') {
            grouped.statusDiffs.push(diff);
            continue;
        }
        grouped.textDiffs.push(diff);
    }

    return grouped;
}

function classifyDiffField(field: string): 'structural' | 'status' | 'text' {
    if (STATUS_FIELDS.has(field)) {
        return 'status';
    }
    if (TEXT_FIELDS.has(field)) {
        return 'text';
    }
    return 'structural';
}

const STATUS_FIELDS = new Set([
    'checkable',
    'checked',
    'clickable',
    'enabled',
    'focused',
    'longClickable',
    'scrollable',
    'selected',
    'visible',
]);

const TEXT_FIELDS = new Set([
    'text',
    'hint',
]);

function collectFieldDiffs(
    mobileComponent: ComponentWithParent,
    twoInOneComponent: ComponentWithParent
): CompareComponentFieldDiff[] {
    const mobileSnapshot = snapshotComparableFields(mobileComponent);
    const twoInOneSnapshot = snapshotComparableFields(twoInOneComponent);
    const diffs: CompareComponentFieldDiff[] = [];

    for (const field of COMPARABLE_FIELDS) {
        const mobileValue = mobileSnapshot[field];
        const twoInOneValue = twoInOneSnapshot[field];
        if (mobileValue === twoInOneValue) {
            continue;
        }
        diffs.push({
            field,
            mobileValue: stringifyValue(mobileValue),
            twoInOneValue: stringifyValue(twoInOneValue),
        });
    }

    diffs.push(...collectChildStructureDiff(mobileComponent.component, twoInOneComponent.component));

    return diffs;
}

function collectChildStructureDiff(left: Component, right: Component): CompareComponentFieldDiff[] {
    const leftChildren = left.children.map(getChildMatchLabel);
    const rightChildren = right.children.map(getChildMatchLabel);
    const leftSet = [...leftChildren].sort();
    const rightSet = [...rightChildren].sort();
    const diffs: CompareComponentFieldDiff[] = [];
    if (JSON.stringify(leftSet) !== JSON.stringify(rightSet)) {
        diffs.push({
            field: 'child-component-set',
            mobileValue: JSON.stringify(leftSet),
            twoInOneValue: JSON.stringify(rightSet),
        });
    }
    if (JSON.stringify(leftChildren) !== JSON.stringify(rightChildren)) {
        diffs.push({
            field: 'child-component-order',
            mobileValue: JSON.stringify(leftChildren),
            twoInOneValue: JSON.stringify(rightChildren),
        });
    }
    return diffs;
}

function getChildMatchLabel(component: Component): string {
    const identity = component.key?.trim() || component.id?.trim();
    if (identity) {
        return `${component.type ?? 'unknown'}::${identity}`;
    }
    const text = (component.text ?? component.hint ?? '').trim();
    return text ? `${component.type ?? 'unknown'}::text:${text}` : `type:${component.type ?? 'unknown'}`;
}

function isInteractive(component: Component): boolean {
    if (component.clickable === true || component.longClickable === true || component.checkable === true) {
        return true;
    }
    if (component.clickable === false && component.longClickable === false && component.checkable === false) {
        return false;
    }
    return /button|checkbox|radio|input|textfield|textinput|search|slider|switch|tab|menu/i.test(component.type ?? '');
}

function snapshotComparableFields(componentWithParent: ComponentWithParent): ComparableComponentFields {
    const component = componentWithParent.component;
    return {
        type: normalizeString(component.type),
        id: normalizeString(component.id),
        key: normalizeString(component.key),
        name: normalizeString(component.name),
        text: normalizeString(component.text),
        hint: normalizeString(component.hint),
        checkable: component.checkable,
        checked: component.checked,
        clickable: component.clickable,
        enabled: component.enabled,
        focused: component.focused,
        longClickable: component.longClickable,
        scrollable: component.scrollable,
        selected: component.selected,
        visible: component.visible,
        debugLine: normalizeString(component.debugLine),
        bounds: normalizeBounds(component.bounds),
        origBounds: normalizeBounds(component.origBounds),
    };
}

function normalizeString(value?: string): string | undefined {
    const trimmed = value?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBounds(bounds?: Point[]): string | undefined {
    if (!bounds || bounds.length === 0) {
        return undefined;
    }
    return bounds.map((point) => `${point.x},${point.y}`).join('|');
}

function stringifyValue(value: unknown): string {
    if (value === undefined) {
        return 'undefined';
    }
    if (value === null) {
        return 'null';
    }
    return String(value);
}
