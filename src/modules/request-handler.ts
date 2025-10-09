/**
 * Request parsing and response handling for the Lambda function
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import fs from 'node:fs'
import { createHttpError } from '../utils/logger.js'
import { isLibreOfficeReady } from './libreoffice.js'
import { validateTemplate } from './conversion.js'

/**
 * Result of parsing request body
 */
export interface ParseResult {
  data: Record<string, any>
  defaultUsed: boolean
}

/**
 * Creates default template data when none provided
 */
function buildDefaultData(): Record<string, any> {
  return {
    example: 'default-render',
    generatedAt: new Date().toISOString()
  }
}

/**
 * Parses the request body and extracts template data
 * @param event - API Gateway event
 * @returns Parsed data and whether defaults were used
 */
export function parseRequestBody(event: APIGatewayProxyEventV2): ParseResult {
  const method = (event as any).requestContext?.http?.method || 'POST'
  
  // GET requests return empty data
  if (method === 'GET') {
    return { data: {}, defaultUsed: false }
  }

  // Extract headers
  const headers = Object.fromEntries(
    Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v])
  )
  const contentType = headers['content-type'] || ''

  // Handle empty body
  if (!event.body || event.body.trim() === '') {
    return { data: buildDefaultData(), defaultUsed: true }
  }

  // Decode body if base64 encoded
  let rawBody = event.body
  if (event.isBase64Encoded) {
    rawBody = Buffer.from(rawBody, 'base64').toString('utf8')
  }

  // Handle form-encoded data
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return parseFormData(rawBody)
  }

  // Handle JSON data
  return parseJsonData(rawBody)
}

/**
 * Parses form-encoded request data
 */
function parseFormData(rawBody: string): ParseResult {
  try {
    const params = new URLSearchParams(rawBody)
    const dataJson = params.get('dataJson') || params.get('data')
    
    if (dataJson) {
      const parsed = JSON.parse(dataJson)
      if (parsed && typeof parsed === 'object') {
        // Check if it has a nested 'data' property
        if ('data' in parsed && parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
          return { data: parsed.data, defaultUsed: false }
        }
        // Use the parsed object directly if it's not an array
        if (!Array.isArray(parsed)) {
          return { data: parsed, defaultUsed: false }
        }
      }
    }
    
    return { data: buildDefaultData(), defaultUsed: true }
  } catch {
    return { data: buildDefaultData(), defaultUsed: true }
  }
}

/**
 * Parses JSON request data
 */
function parseJsonData(rawBody: string): ParseResult {
  let json: any
  
  try {
    json = JSON.parse(rawBody)
  } catch {
    throw createHttpError('Invalid JSON body', 400)
  }

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw createHttpError('Body must be an object', 400)
  }

  if (!('data' in json)) {
    return { data: buildDefaultData(), defaultUsed: true }
  }

  if (!json.data || typeof json.data !== 'object' || Array.isArray(json.data)) {
    throw createHttpError('"data" must be an object', 400)
  }

  return { data: json.data, defaultUsed: false }
}

/**
 * Creates a successful PDF response
 * @param pdf - PDF buffer
 * @returns API Gateway response
 */
export function createPdfResponse(pdf: Buffer): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 200,
    isBase64Encoded: true,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="generated.pdf"'
    },
    body: pdf.toString('base64')
  }
}

/**
 * Creates an error response
 * @param error - Error object
 * @param defaultStatusCode - Default status code if error doesn't have one
 * @returns API Gateway response
 */
export function createErrorResponse(
  error: any,
  defaultStatusCode: number = 500
): APIGatewayProxyStructuredResultV2 {
  const statusCode = (error?.statusCode && Number.isInteger(error.statusCode)) 
    ? error.statusCode 
    : defaultStatusCode

  return {
    statusCode,
    isBase64Encoded: false,
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: error?.message || 'Internal Server Error'
    })
  }
}

/**
 * Creates an input form HTML response (formerly health check)
 * Provides template status plus a form for manual data submission.
 */
export function createInputFormResponse(): APIGatewayProxyStructuredResultV2 {
  const isTemplateValid = validateTemplate()
  const isLoReady = isLibreOfficeReady()
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <title>Carbone PDF Input Form</title>
  <style>
    body { font-family: system-ui, Arial, sans-serif; margin: 2rem; line-height: 1.4; }
    textarea { width: 100%; font-family: monospace; }
    fieldset { margin-top: 1rem; }
    .status { padding: 0.5rem; border-radius: 4px; margin: 0.5rem 0; }
    .status.ok { background-color: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
    .status.warning { background-color: #fff3cd; color: #856404; border: 1px solid #ffeaa7; }
    footer { margin-top: 2rem; font-size: 0.8rem; color: #555; }
  </style>
</head>
<body>
  <h1>Carbone PDF Render – Input Form</h1>
  <div class="status ${isLoReady && isTemplateValid ? 'ok' : 'warning'}">
    <strong>Template status:</strong> ${isTemplateValid ? 'Available' : 'Missing'}<br/>
    <strong>Rendering engine:</strong> ${isLoReady ? 'LibreOffice ready' : 'Not initialised'}
  </div>
  <p>Submit JSON below to render the DOCX template to PDF. Provide an object of the form:
     <code>{"data": { ...fields }}</code>. If <code>data</code> is missing or invalid, default mock data is used.
  </p>
  <form method="POST" action="/" enctype="application/x-www-form-urlencoded" target="_blank">
    <fieldset>
      <legend>Render PDF</legend>
      <textarea name="dataJson" rows="12">{
  "data": {
    "example": "value",
    "fullName": "Alice Dobbs",
    "date": "${new Date().toISOString().substring(0, 10)}",
    "nhsNumber": "9990000000"
  }
}</textarea>
      <div style="margin-top: 0.5rem;">
        <button type="submit">Render PDF (new tab)</button>
      </div>
    </fieldset>
  </form>
  <hr/>
  <details>
    <summary>System Information</summary>
    <ul>
      <li><strong>Node.js Version:</strong> ${process.version}</li>
      <li><strong>Platform:</strong> ${process.platform}</li>
      <li><strong>Architecture:</strong> ${process.arch}</li>
      <li><strong>Memory Usage:</strong> ${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB</li>
      <li><strong>Uptime:</strong> ${Math.round(process.uptime())} seconds</li>
    </ul>
  </details>
  <footer>
    Default data fallback active. Built at: ${new Date().toISOString()}
  </footer>
</body>
</html>`

  return {
    statusCode: 200,
    isBase64Encoded: false,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    body: html
  }
}

/**
 * Determines if the request is a GET request
 */
export function isGetRequest(event: APIGatewayProxyEventV2): boolean {
  return (event as any).requestContext?.http?.method === 'GET'
}