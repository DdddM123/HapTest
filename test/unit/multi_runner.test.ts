import { describe, expect, it } from 'vitest';
import path from 'path';
import { buildMultiRunPlan, parseMultiDeviceConfig } from '../../src/cli/multi_runner';

describe('multi runner plan', () => {
    it('builds isolated outputs for each target', () => {
        const config = parseMultiDeviceConfig(
            JSON.stringify({
                targets: [
                    { connectkey: 'phone-001', name: 'phone' },
                    { connectkey: 'pc-001', name: 'pc', output: 'out/custom-pc' },
                ],
            })
        );

        const plan = buildMultiRunPlan(
            {
                hap: 'com.example.demo',
                output: 'out/multi',
                policyName: 'manu',
                coverage: false,
                reportRoot: undefined,
                excludes: undefined,
                startFromCurrentPage: true,
                llm: false,
                simK: 8,
                staticConfig: undefined,
            },
            config
        );

        expect(plan).toHaveLength(2);
        expect(plan[0].connectkey).toBe('phone-001');
        expect(plan[0].output).toContain('out/multi/phone');
        expect(plan[0].startFromCurrentPage).toBe(true);
        expect(plan[1].connectkey).toBe('pc-001');
        expect(plan[1].output).toBe(path.resolve('out/custom-pc'));
    });

    it('rejects configs without targets', () => {
        expect(() => parseMultiDeviceConfig(JSON.stringify({ targets: [] }))).toThrowError(
            'Multi-device config requires at least one target.'
        );
    });
});