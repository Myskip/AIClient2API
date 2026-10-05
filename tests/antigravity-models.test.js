jest.mock('open', () => ({
    __esModule: true,
    default: jest.fn()
}));
jest.mock('../src/utils/proxy-utils.js', () => ({
    configureTLSSidecar: jest.fn(),
    getProxyConfigForProvider: jest.fn(),
    getGoogleAuthProxyConfig: jest.fn(),
    isTLSSidecarEnabledForProvider: jest.fn(() => false)
}));

import { AntigravityApiService, isAntigravityModelRetired } from '../src/providers/gemini/antigravity-core.js';
import { PROVIDER_MODELS } from '../src/providers/provider-models.js';

describe('Antigravity model availability', () => {
    const cutoff = Date.UTC(2026, 10, 3);

    test('includes the supplied Gemini Medium aliases and GPT-OSS model', () => {
        expect(PROVIDER_MODELS['gemini-antigravity']).toEqual(expect.arrayContaining([
            'gemini-3.6-flash-medium',
            'gemini-3.7-flash-medium',
            'gemini-3.8-flash-medium',
            'gemini-3.1-pro-low',
            'gemini-claude-sonnet-4-6',
            'gemini-claude-opus-4-6-thinking',
            'gpt-oss-120b-medium'
        ]));
    });

    test('applies the retirement cutoff only to explicitly free-tier accounts', () => {
        expect(isAntigravityModelRetired('gemini-claude-sonnet-4-6', cutoff - 1, 'free-tier')).toBe(false);
        expect(isAntigravityModelRetired('gemini-claude-sonnet-4-6', cutoff, 'free-tier')).toBe(true);
        expect(isAntigravityModelRetired('gpt-oss-120b-medium', cutoff, 'free-tier')).toBe(true);
        expect(isAntigravityModelRetired('gemini-3.8-flash-medium', cutoff, 'free-tier')).toBe(false);
        expect(isAntigravityModelRetired('gemini-claude-sonnet-4-6', cutoff - 1, 'Google AI Pro(free)')).toBe(false);
        expect(isAntigravityModelRetired('gemini-claude-sonnet-4-6', cutoff, 'Google AI Pro(free)')).toBe(false);
        expect(isAntigravityModelRetired('gemini-claude-sonnet-4-6', cutoff - 1, undefined)).toBe(false);
        expect(isAntigravityModelRetired('gemini-claude-sonnet-4-6', cutoff, undefined)).toBe(false);
    });

    test('filters model lists and direct requests according to account tier', async () => {
        jest.useFakeTimers().setSystemTime(cutoff);

        try {
            const createService = tierId => {
                const service = Object.create(AntigravityApiService.prototype);
                service.isInitialized = true;
                service.tierId = tierId;
                service.availableModels = [
                    'gemini-3.8-flash-medium',
                    'gemini-claude-sonnet-4-6',
                    'gpt-oss-120b-medium'
                ];
                return service;
            };

            const freeService = createService('free-tier');
            const freeResponse = await freeService.listModels();
            expect(freeResponse.models.map(model => model.name)).toEqual([
                'models/gemini-3.8-flash-medium'
            ]);
            expect(() => freeService.buildAntigravityPayload('gemini-claude-sonnet-4-6', {}))
                .toThrow('Free-plan access to non-Gemini model');
            expect(() => freeService.buildAntigravityPayload('gpt-oss-120b-medium', {}))
                .toThrow('Free-plan access to non-Gemini model');

            for (const tierId of ['Google AI Pro', undefined]) {
                const service = createService(tierId);
                const response = await service.listModels();
                expect(response.models.map(model => model.name)).toEqual([
                    'models/gemini-3.8-flash-medium',
                    'models/gemini-claude-sonnet-4-6',
                    'models/gpt-oss-120b-medium'
                ]);
            }
        } finally {
            jest.useRealTimers();
        }
    });
});