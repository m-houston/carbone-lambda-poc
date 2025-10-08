#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'

const root = resolve(process.cwd(), '.')
const pkgDir = resolve(root, 'package')
const zipFile = resolve(root, 'lambda.zip')

if (!existsSync(pkgDir)) {
  console.error('[package] package directory missing. Run build first.')
  process.exit(1)
}

console.log('[package] creating lambda.zip')
try {
  execSync(`cd ${pkgDir} && zip -rq ${zipFile} .` , { stdio: 'inherit' })
  console.log('[package] lambda.zip created')
} catch (e) {
  console.error('[package] zip failed', e)
  process.exit(1)
}

