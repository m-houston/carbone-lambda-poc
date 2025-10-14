import path from 'node:path'
import fs from 'node:fs'
import { getTemplatesDir, listTemplates, ensureTemplateInfo } from '../modules/template-markers'

// Helper to skip test gracefully if no templates present
function hasTemplates() {
  try { return fs.readdirSync(getTemplatesDir()).some(f => f.endsWith('.docx')) } catch { return false }
}

describe('template marker extraction', () => {
  test('templates directory resolved', () => {
    const dir = getTemplatesDir()
    expect(typeof dir).toBe('string')
    expect(path.isAbsolute(dir)).toBe(true)
  })

  test('listTemplates returns empty array or marker info objects', () => {
    const list = listTemplates()
    expect(Array.isArray(list)).toBe(true)
    list.forEach(t => {
      expect(t).toHaveProperty('name')
      expect(t).toHaveProperty('file')
      expect(t).toHaveProperty('markers')
      expect(Array.isArray(t.markers)).toBe(true)
      // markers array should be sorted and unique
      const sorted = [...t.markers].sort()
      expect(sorted).toEqual(t.markers)
      const unique = new Set(t.markers)
      expect(unique.size).toBe(t.markers.length)
    })
  })

  test('marker extraction yields non-empty markers when template contains carbone markers', () => {
    if (!hasTemplates()) {
      throw new Error('no templates present, cannot test marker extraction')
    }
    const templates = listTemplates()
    const anyWithMarkers = templates.some(t => t.markers.length > 0)
    if (!anyWithMarkers) {
      throw new Error('no markers found in any template, cannot test marker extraction')
    }
    const firstWith = templates.find(t => t.markers.length > 0)!
    expect(firstWith.markers.length).toBeGreaterThan(0)
    firstWith.markers.forEach(m => expect(m).toMatch(/^[A-Za-z0-9_.-]+$/))
  })

  test('cache stability (size unchanged -> same object returned)', () => {
    if (!hasTemplates()) {
      throw new Error('no templates present, cannot test marker extraction')
    }
    const [first] = listTemplates()
    const again = ensureTemplateInfo(first.path)
    // Should return cached reference (same size & same markers arrays equal)
    expect(again.markers).toEqual(first.markers)
  })

  test('missing template throws', () => {
    expect(() => ensureTemplateInfo(path.join(getTemplatesDir(), 'non-existent.docx'))).toThrow()
  })
})
