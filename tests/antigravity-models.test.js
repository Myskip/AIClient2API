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
import { handleStreamRequest, handleUnaryRequest } from '../src/utils/common.js';

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

    test.each([
        ['unary', handleUnaryRequest, 'generateContent'],
        ['streaming', handleStreamRequest, 'generateContentStream']
    ])('reports a retired model as a non-retryable client error for %s requests', async (_label, handler, method) => {
        jest.useFakeTimers().setSystemTime(cutoff);

        const service = Object.create(AntigravityApiService.prototype);
        service.tierId = 'free-tier';
        service.availableModels = ['gemini-claude-sonnet-4-6'];
        let policyError;
        try {
            service.buildAntigravityPayload('gemini-claude-sonnet-4-6', {});
        } catch (error) {
            policyError = error;
        } finally {
            jest.useRealTimers();
        }

        expect(policyError).toMatchObject({
            status: 400,
            response: { status: 400 },
            skipErrorCount: true
        });

        const requestService = { [method]: jest.fn().mockRejectedValue(policyError) };
        const poolManager = {
            markProviderHealthy: jest.fn(),
            markProviderUnhealthy: jest.fn(),
            markProviderUnhealthyWithRecoveryTime: jest.fn(),
            releaseSlot: jest.fn()
        };
        const response = {
            writableEnded: false,
            writeHead: jest.fn(function (statusCode) {
                this.statusCode = statusCode;
            }),
            write: jest.fn(),
            end: jest.fn(function () {
                this.writableEnded = true;
            }),
            on: jest.fn(),
            off: jest.fn()
        };

        await handler(
            response,
            requestService,
            'gemini-claude-sonnet-4-6',
            {},
            'gemini',
            'gemini-antigravity',
            'none',
            null,
            poolManager,
            'healthy-account',
            null,
            { CONFIG: {}, maxRetries: 2 }
        );

        expect(requestService[method]).toHaveBeenCalledTimes(1);
        expect(poolManager.markProviderUnhealthy).not.toHaveBeenCalled();
        expect(poolManager.markProviderUnhealthyWithRecoveryTime).not.toHaveBeenCalled();
        expect(poolManager.releaseSlot).toHaveBeenCalledWith('gemini-antigravity', 'healthy-account');
        if (method === 'generateContent') {
            expect(response.statusCode).toBe(400);
        } else {
            const streamPayload = response.write.mock.calls.flat().join('');
            expect(response.statusCode).toBe(200);
            expect(streamPayload).toContain('"code":400');
            expect(streamPayload).toContain('INVALID_ARGUMENT');
            expect(streamPayload).toContain('ended on 2026-11-03');
        }
    });
});