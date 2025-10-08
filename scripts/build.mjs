#!/usr/bin/env node
import { build } from 'esbuild'
import { mkdirSync, cpSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const outDir = resolve(root, 'package')
const templateSrc = resolve(root, 'templates', 'letter-template-nhs-notify_.docx')
const templateDestDir = resolve(outDir, 'templates')

async function run() {
  console.log('[build] start')
  if (existsSync(outDir)) {
    rmSync(outDir, { recursive: true, force: true })
  }
  mkdirSync(outDir, { recursive: true })

  await build({
    entryPoints: [resolve(root, 'src', 'index.ts')],
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    bundle: false,
    outdir: outDir,
    outExtension: { '.js': '.cjs' },
    logLevel: 'info'
  })

  mkdirSync(templateDestDir, { recursive: true })
  cpSync(templateSrc, resolve(templateDestDir, 'letter-template-nhs-notify_.docx'))

  const rootPkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const lambdaPkg = {
    name: rootPkg.name,
    version: rootPkg.version,
    main: 'index.cjs',
    type: 'commonjs',
    dependencies: rootPkg.dependencies
  }
  writeFileSync(resolve(outDir, 'package.json'), JSON.stringify(lambdaPkg, null, 2))

  console.log('[build] installing production dependencies (omit dev)')
  execSync('npm install --omit=dev --ignore-scripts', { cwd: outDir, stdio: 'inherit' })

  console.log('[build] complete')
}

run().catch(e => { console.error('[build] failed', e); process.exit(1) })
