import type { FastifyInstance } from 'fastify'
import { getHITLGate } from '../core/agent/hitl-gate.js'
import { getToolRegistry } from '../core/tools/tool-registry.js'

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/agent/tool-approvals — get all tool approval states
  app.get('/tool-approvals', async () => {
    const gate = getHITLGate()
    return gate.getAllApprovals()
  })

  // PUT /api/agent/tool-approvals — bulk-set tool approval states
  app.put<{ Body: Record<string, boolean> }>('/tool-approvals', async (req, reply) => {
    const approvals = req.body
    if (!approvals || typeof approvals !== 'object') {
      return reply.status(400).send({ error: 'Expected { toolName: boolean } map' })
    }
    const gate = getHITLGate()
    gate.setAutoApproveBulk(approvals)
    return { success: true }
  })

  // PUT /api/agent/tool-approvals/:toolName — set approval for a specific tool
  app.put<{ Params: { toolName: string }; Body: { autoApprove: boolean } }>(
    '/tool-approvals/:toolName',
    async (req, reply) => {
      const { toolName } = req.params
      const { autoApprove } = req.body
      if (typeof autoApprove !== 'boolean') {
        return reply.status(400).send({ error: 'Expected { autoApprove: boolean }' })
      }
      const gate = getHITLGate()
      gate.setAutoApprove(toolName, autoApprove)
      return { success: true, toolName, autoApprove }
    }
  )

  // GET /api/agent/tools — list registered tools
  app.get('/tools', async () => {
    const registry = getToolRegistry()
    const gate = getHITLGate()
    const approvals = gate.getAllApprovals()
    const items = registry.getAllWithNamespaces()
    return items.map(({ tool: t, namespace: ns }) => ({
      name: t.name,
      description: t.description,
      autoApprove: approvals[t.name] ?? false,
      namespace: ns
    }))
  })
}
