import esbuild from 'esbuild'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const outdir = './package/public'

// Make sure the directory exists
if (!existsSync(outdir)) {
  mkdirSync(outdir, { recursive: true })
}

// Build the client bundle
async function build() {
  try {
    const result = await esbuild.build({
      entryPoints: ['./src/templates/input-form/client.js'],
      bundle: true,
      minify: true,
      format: 'iife',
      target: ['es2020'],
      outfile: `${outdir}/input-form.js`,
      sourcemap: 'external',
      metafile: true
    })

    const { outputFiles, metafile } = result
    if (metafile) {
      const sizes = {}
      Object.keys(metafile.outputs).forEach((output) => {
        const bytes = metafile.outputs[output].bytes
        sizes[output] = `${(bytes / 1024).toFixed(2)} KB`
      })
      
      console.log('✅ Client bundle built successfully:', sizes)
    }
    
    return 0
  } catch (error) {
    console.error('❌ Client bundle build failed:', error)
    return 1
  }
}

// Execute build
const exitCode = await build()
process.exit(exitCode)