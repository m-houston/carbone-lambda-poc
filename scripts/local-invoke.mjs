#!/usr/bin/env node
import { resolve } from 'node:path'
import { writeFile } from 'node:fs/promises'

// Usage:
//  node scripts/local-invoke.mjs                 -> POST with empty body (default data)
//  node scripts/local-invoke.mjs '{"data":{}}'   -> POST with explicit data
//  node scripts/local-invoke.mjs --get           -> GET health check
//  node scripts/local-invoke.mjs --form          -> POST x-www-form-urlencoded data
// Requires: npm run build (so package/index.cjs exists)
// Sets SKIP_CONVERT=1 to avoid needing LibreOffice locally.

const root = resolve(process.cwd())
const handlerModule = await import(resolve(root, 'package', 'index.cjs'))
const handler = handlerModule.handler

const arg = process.argv[2]
const arg2 = process.argv[3]
process.env.SKIP_CONVERT = '1'

let event
if (arg === '--get') {
  event = {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/',
    rawQueryString: '',
    headers: {},
    requestContext: { requestId: 'local-test', stage: '$default', http: { method: 'GET' } },
    isBase64Encoded: false
  }
} else if (arg === '--form') {
  const sample = arg2 || '{"data":{"formField":"Example","number":123}}'
  const bodyEnc = `dataJson=${encodeURIComponent(sample)}`
  event = {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/',
    rawQueryString: '',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    requestContext: { requestId: 'local-test', stage: '$default', http: { method: 'POST' } },
    body: bodyEnc,
    isBase64Encoded: false
  }
} else {
  let bodyString = ''
  if (arg) {
    bodyString = arg
  }
  event = {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/',
    rawQueryString: '',
    headers: { 'content-type': 'application/json' },
    requestContext: { requestId: 'local-test', stage: '$default', http: { method: 'POST' } },
    body: bodyString,
    isBase64Encoded: false
  }
}

const context = { awsRequestId: 'local-aws-request-id' }

const result = await handler(event, context)
console.log('Lambda result status:', result.statusCode)
if (result.statusCode === 200) {
  const contentType = (result.headers?.['Content-Type'] || result.headers?.['content-type'] || '').toString()
  if (contentType.includes('application/pdf')) {
    const outPath = resolve(root, 'local-output.pdf')
    await writeFile(outPath, Buffer.from(result.body, 'base64'))
    console.log('PDF written to', outPath)
  } else if (contentType.includes('text/html')) {
    const htmlPath = resolve(root, 'local-health.html')
    await writeFile(htmlPath, result.body, 'utf8')
    console.log('HTML written to', htmlPath)
  } else {
    console.log('JSON/Other response:', result.body)
  }
} else {
  console.log('Error body:', result.body)
}
