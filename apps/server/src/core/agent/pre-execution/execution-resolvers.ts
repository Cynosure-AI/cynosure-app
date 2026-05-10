import type { LLMGateway } from '../../gateway/gateway.js'

export interface ProviderModelResolution {
    providerId: string
    model: string
}

export interface RouterResolution {
    providerId: string
    model: string
}

export function resolveProviderAndModel(params: {
    gateway: LLMGateway
    baseProviderId?: string
    baseModel?: string
    providerOverride?: string
    modelOverride?: string
}): ProviderModelResolution {
    const {
        gateway,
        baseProviderId,
        baseModel,
        providerOverride,
        modelOverride,
    } = params

    const activeProviderId = providerOverride || baseProviderId || undefined
    const activeProvider = activeProviderId
        ? gateway.getProvider(activeProviderId) || gateway.getLastUsedProvider()
        : gateway.getLastUsedProvider()

    // When provider is overridden without a model override, ignore the base
    // model because it may belong to a different provider.
    const model = modelOverride
        || (providerOverride ? undefined : baseModel)
        || activeProvider.config.defaultModel

    return {
        providerId: activeProvider.config.id,
        model,
    }
}

export function resolveRouterProviderModel(params: {
    gateway: LLMGateway
    fallbackProviderId: string
    fallbackModel: string
    agentRouterProviderId?: string
    agentRouterModel?: string
    requestRouterProviderId?: string
    requestRouterModel?: string
}): RouterResolution {
    const {
        gateway,
        fallbackProviderId,
        fallbackModel,
        agentRouterProviderId,
        agentRouterModel,
        requestRouterProviderId,
        requestRouterModel,
    } = params

    const routerProviderId = agentRouterProviderId || requestRouterProviderId || fallbackProviderId
    const routerProvider = gateway.getProvider(routerProviderId) || gateway.getLastUsedProvider()
    const model = agentRouterModel
        || requestRouterModel
        || routerProvider.config.defaultModel
        || fallbackModel

    return {
        providerId: routerProvider.config.id,
        model,
    }
}
