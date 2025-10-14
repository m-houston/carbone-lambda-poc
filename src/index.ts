import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda'
import { log, serializeError, hasStatusCode } from './utils/logger.js'
import { ensureWarmup } from './modules/warmup.js'
import { renderPdf } from './modules/conversion.js'
import { listTemplates } from './modules/template-markers.js'
import {
  parseRequestBody,
  createPdfResponse,
  createErrorResponse,
  createInputFormResponse,
  isGetRequest,
  validateAuth,
  createAuthChallengeResponse
} from './modules/request-handler.js'

/**
 * Main Lambda handler for PDF generation
 * GET returns an input form + status page
 */
export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context
): Promise<APIGatewayProxyStructuredResultV2> => {
  const requestId = event.requestContext?.requestId || context.awsRequestId
  const start = Date.now()

  try {
    // Check authentication first
    if (!validateAuth(event)) {
      log('warn', 'Authentication failed', { requestId })
      return createAuthChallengeResponse()
    }

    // Simple routing based on rawPath
    const rawPath = (event as any).rawPath || event.requestContext?.http?.path || '/'
    if (event.requestContext?.http?.method === 'GET' && rawPath.endsWith('/templates')) {
      await ensureWarmup()
      const templates = listTemplates().map(t => ({
        name: t.name,
        file: t.file,
        size: t.size,
        markers: t.markers
      }))
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        isBase64Encoded: false,
        body: JSON.stringify({ templates })
      }
    }

    // GET returns interactive input form
    if (isGetRequest(event)) {
      await ensureWarmup()
      return createInputFormResponse()
    }

    await ensureWarmup()
  const { data, defaultUsed, templateName } = parseRequestBody(event)
    log('info', 'Rendering start', { requestId, defaultUsed })
  const pdf = await renderPdf(data, templateName)
    const durationMs = Date.now() - start
    log('info', 'Rendering success', { requestId, durationMs, size: pdf.length, defaultUsed })
    return createPdfResponse(pdf)
  } catch (error: any) {
    const statusCode = hasStatusCode(error) ? error.statusCode : 500
    log('error', 'Rendering failed', { requestId, statusCode, error: error?.message, stack: process.env.DEBUG_RENDER === '1' ? error?.stack : undefined })
    return createErrorResponse(error, statusCode)
  }
}
