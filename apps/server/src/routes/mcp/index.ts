import type { FastifyInstance } from 'fastify'
import { registerMcpServerRoutes } from './servers.js'
import { registerMcpRegistryRoutes } from './registry.js'

export { loadSavedMcpServers } from './servers.js'

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
    await registerMcpServerRoutes(app)
    await registerMcpRegistryRoutes(app)
}
