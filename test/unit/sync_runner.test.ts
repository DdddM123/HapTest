import { describe, expect, it } from 'vitest';
import { compareSyncPages } from '../../src/runner/sync_runner';
import { Component } from '../../src/model/component';
import { Page } from '../../src/model/page';
import { ViewTree } from '../../src/model/viewtree';

function createPage(text: string): Page {
    const root = new Component();
    root.type = 'Root';
    root.text = text;
    root.bounds = [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
    ];
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