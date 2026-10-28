import { describe, expect, it } from 'vitest';
import { Direct } from '../../src/device/event_simulator';
import { ScrollEvent, TouchEvent } from '../../src/event/ui_event';
import { Component } from '../../src/model/component';
import { Page } from '../../src/model/page';
import { ViewTree } from '../../src/model/viewtree';
import { detectDynamicPageIssues, detectDynamicTransitionIssues } from '../../src/compare/detectors/dynamic_detector';

function component(options: Partial<Component> = {}): Component {
    const value = Object.assign(new Component(), options);
    value.bounds ??= [{ x: 0, y: 0 }, { x: 100, y: 100 }];
    return value;
}

function page(pagePath: string, children: Component[]): Page {
    const root = component({ type: 'Root', bounds: [{ x: 0, y: 0 }, { x: 100, y: 200 }], children });
    for (const child of children) {
        child.parent = root;
    }
    return new Page(new ViewTree(root), 'Ability', 'com.example.demo', pagePath);
}

describe('dynamic detector', () => {
    it('reports identity and unusable interactive components', () => {
        const mobile = page('pages/Home', [component({ type: 'Button', key: 'submit', clickable: true, bounds: [] })]);
        const twoInOne = page('pages/Profile', []);
        const issues = detectDynamicPageIssues(0, mobile, twoInOne, 'mobile.png', '2in1.png');
        expect(issues.map((issue) => issue.kind)).toEqual([
            'page-identity-mismatch',
            'interactive-component-unusable',
        ]);
    });

    it('reports event type changes between devices', () => {
        const from = page('pages/Home', []);
        const to = page('pages/Detail', []);
        const issues = detectDynamicTransitionIssues(
            1, from, to, new TouchEvent({ x: 1, y: 1 }), from, to,
            new ScrollEvent({ x: 1, y: 1 }, Direct.DOWN), 'a.png', 'b.png'
        );
        expect(issues[0].kind).toBe('event-type-mismatch');
    });
});