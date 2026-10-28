import { Component } from '../model/component';
import { Page } from '../model/page';
import { Point } from '../model/point';
import { BoundsBox, ScreenRect } from './types';

export function getScreenRect(page: Page): ScreenRect | undefined {
    const box = getScreenBox(page);
    return box ? { left: box.left, right: box.right } : undefined;
}

export function getScreenBox(page: Page): BoundsBox | undefined {
    const rootBox = getBoundsBox(page.getRoot().bounds ?? page.getRoot().origBounds);
    if (rootBox && rootBox.right > rootBox.left && rootBox.bottom > rootBox.top) {
        return rootBox;
    }

    let screenBox: BoundsBox | undefined;
    for (const component of page.getComponents()) {
        const box = getBoundsBox(component.bounds ?? component.origBounds);
        if (!box) {
            continue;
        }
        screenBox = screenBox
            ? {
                  left: Math.min(screenBox.left, box.left),
                  right: Math.max(screenBox.right, box.right),
                  top: Math.min(screenBox.top, box.top),
                  bottom: Math.max(screenBox.bottom, box.bottom),
              }
            : box;
    }

    return screenBox && screenBox.right > screenBox.left && screenBox.bottom > screenBox.top
        ? screenBox
        : undefined;
}

export function getBoundsRect(bounds?: Point[]): ScreenRect | undefined {
    const box = getBoundsBox(bounds);
    if (!box) {
        return undefined;
    }
    return { left: box.left, right: box.right };
}

export function getBoundsBox(bounds?: Point[]): BoundsBox | undefined {
    if (!bounds || bounds.length < 2) {
        return undefined;
    }
    const xs = bounds.map((point) => point.x);
    const ys = bounds.map((point) => point.y);
    return {
        left: Math.min(...xs),
        right: Math.max(...xs),
        top: Math.min(...ys),
        bottom: Math.max(...ys),
    };
}

export function getAspectRatio(component: Component): number | undefined {
    const rect = getBoundsBox(component.bounds ?? component.origBounds);
    if (!rect) {
        return undefined;
    }
    const width = rect.right - rect.left;
    const height = rect.bottom - rect.top;
    if (width <= 0 || height <= 0) {
        return undefined;
    }
    return width / height;
}
