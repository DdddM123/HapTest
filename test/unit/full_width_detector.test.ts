import { describe, expect, it } from 'vitest';
import { Component } from '../../src/model/component';
import { Page } from '../../src/model/page';
import { ViewTree } from '../../src/model/viewtree';
import { detectFullWidthIssues } from '../../src/compare/detectors/full_width_detector';

function createPage(buttonBounds: Array<{ x: number; y: number }>): Page {
    const root = new Component();
    root.type = 'Root';
    root.key = 'root';
    root.bounds = [{ x: 0, y: 0 }, { x: 100, y: 100 }];
    const button = new Component();
    button.type = 'Button';
    button.key = 'submit';
    button.bounds = buttonBounds;
    button.parent = root;
    root.children = [button];
    return new Page(new ViewTree(root), 'Ability', 'com.example.demo', 'pages/index');
}

describe('detectFullWidthIssues', () => {
    it('reports only when full-width status differs between devices', async () => {
        const fullWidth = createPage([{ x: 0, y: 0 }, { x: 100, y: 20 }]);
        const narrow = createPage([{ x: 10, y: 0 }, { x: 90, y: 20 }]);
        const issues = await detectFullWidthIssues(0, fullWidth, narrow, 'a.png', 'b.png', 1);
        expect(issues).toHaveLength(1);
        expect(issues[0].componentName).toContain('submit');
    });

    it('does not report when both devices have the same full-width status', async () => {
        const narrow = createPage([{ x: 10, y: 0 }, { x: 90, y: 20 }]);
        const issues = await detectFullWidthIssues(0, narrow, narrow, 'a.png', 'b.png', 1);
        expect(issues).toHaveLength(0);
    });
});