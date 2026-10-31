import { Event } from '../../event/event';
import { Component } from '../../model/component';
import { Page } from '../../model/page';
import { getBoundsBox, getScreenBox } from '../geometry';
import { CompareDynamicIssue } from '../types';
import { checkOperationPages, OperationPageCheckResult } from '../operation_page_checker';

export function detectDynamicPageIssues(
    pageIndex: number,
    mobilePage: Page,
    twoInOnePage: Page,
    mobileScreenshot: string,
    twoInOneScreenshot: string,
    pageCheck: OperationPageCheckResult = checkOperationPages(mobilePage, twoInOnePage)
): CompareDynamicIssue[] {
    const issues: CompareDynamicIssue[] = [];
    if (pageCheck.decision === 'DIFFERENT_PAGE') {
        issues.push({
            kind: 'page-identity-mismatch',
            pageIndex,
            device: 'both',
            reason: `${pageCheck.rule}: ${pageCheck.reason}`,
            mobilePagePath: mobilePage.getPagePath(),
            twoInOnePagePath: twoInOnePage.getPagePath(),
            mobileScreenshot,
            twoInOneScreenshot,
        });
    }

    issues.push(...detectInteractiveComponentIssues(
        'mobile', pageIndex, mobilePage, twoInOnePage, mobileScreenshot, twoInOneScreenshot
    ));
    issues.push(...detectInteractiveComponentIssues(
        '2in1', pageIndex, twoInOnePage, mobilePage, mobileScreenshot, twoInOneScreenshot
    ));
    return issues;
}

export function detectDynamicTransitionIssues(
    transitionIndex: number,
    mobileFrom: Page,
    mobileTo: Page,
    mobileEvent: Event | undefined,
    twoInOneFrom: Page,
    twoInOneTo: Page,
    twoInOneEvent: Event | undefined,
    mobileScreenshot: string,
    twoInOneScreenshot: string
): CompareDynamicIssue[] {
    const mobileEventType = getEventType(mobileEvent);
    const twoInOneEventType = getEventType(twoInOneEvent);
    if (!mobileEventType || !twoInOneEventType || mobileEventType === twoInOneEventType) {
        return [];
    }
    return [{
        kind: 'event-type-mismatch',
        pageIndex: transitionIndex,
        transitionIndex,
        device: 'both',
        reason: `event types differ: mobile=${mobileEventType}, 2in1=${twoInOneEventType}`,
        mobilePagePath: mobileFrom.getPagePath() || mobileTo.getPagePath(),
        twoInOnePagePath: twoInOneFrom.getPagePath() || twoInOneTo.getPagePath(),
        mobileScreenshot,
        twoInOneScreenshot,
    }];
}

function detectInteractiveComponentIssues(
    device: 'mobile' | '2in1',
    pageIndex: number,
    page: Page,
    otherPage: Page,
    mobileScreenshot: string,
    twoInOneScreenshot: string
): CompareDynamicIssue[] {
    const screenBox = getScreenBox(page);
    if (!screenBox) {
        return [];
    }

    const issues: CompareDynamicIssue[] = [];
    for (const component of page.getComponents()) {
        if (!isInteractive(component)) {
            continue;
        }
        const componentName = getComponentName(component);
        const rect = getBoundsBox(component.bounds ?? component.origBounds);
        if (!rect || rect.right <= rect.left || rect.bottom <= rect.top) {
            issues.push(buildComponentIssue(
                'interactive-component-unusable',
                device,
                pageIndex,
                componentName,
                'interactive component has no usable bounds',
                page,
                otherPage,
                mobileScreenshot,
                twoInOneScreenshot
            ));
            continue;
        }
        if (
            rect.left < screenBox.left ||
            rect.right > screenBox.right ||
            rect.top < screenBox.top ||
            rect.bottom > screenBox.bottom
        ) {
            issues.push(buildComponentIssue(
                'interactive-component-out-of-window',
                device,
                pageIndex,
                componentName,
                'interactive component extends beyond the current window',
                page,
                otherPage,
                mobileScreenshot,
                twoInOneScreenshot
            ));
        }
    }
    return issues;
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

function getComponentName(component: Component): string {
    return component.key?.trim() || component.id?.trim() || component.name?.trim() || component.type?.trim() || 'unknown';
}

function buildComponentIssue(
    kind: 'interactive-component-unusable' | 'interactive-component-out-of-window',
    device: 'mobile' | '2in1',
    pageIndex: number,
    componentName: string,
    reason: string,
    page: Page,
    otherPage: Page,
    mobileScreenshot: string,
    twoInOneScreenshot: string
): CompareDynamicIssue {
    return {
        kind,
        pageIndex,
        device,
        componentName,
        reason,
        mobilePagePath: page.getPagePath(),
        twoInOnePagePath: otherPage.getPagePath(),
        mobileScreenshot,
        twoInOneScreenshot,
    };
}

function getEventType(event: Event | undefined): string | undefined {
    const type = event?.toJson()?.type;
    return typeof type === 'string' && type.trim().length > 0 ? type.trim() : undefined;
}
