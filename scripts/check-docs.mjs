/** Check this independent plugin's bilingual README using the Harness pairing implementation. */
import assert from 'node:assert/strict'
import { readFile, writeFile, access } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkout = resolve(root, '../../..')
const { translationPairPaths, computeTranslationPairingRecord, renderTranslationPairingRecord, parseTranslationPairingRecord, translationPairingRecordDiff } = await import(pathToFileURL(resolve(checkout, 'scripts/translation-pairing-record.ts')).href)
const paths = translationPairPaths('README.md')
const [en, zh] = await Promise.all([readFile(resolve(root, paths.source), 'utf8'), readFile(resolve(root, paths.zh), 'utf8')])
const record = computeTranslationPairingRecord(paths, en, zh, { repoRoot: root, isTranslationPairSource: path => path === 'README.md' })
if (process.argv.includes('--record')) await writeFile(resolve(root, paths.meta), renderTranslationPairingRecord(paths, record))
const persisted = parseTranslationPairingRecord(await readFile(resolve(root, paths.meta), 'utf8'))
assert.deepEqual(translationPairingRecordDiff(persisted, record), [])
for (const [name, text] of [[paths.source, en], [paths.zh, zh]]) {
  assert.ok(text.endsWith(String.fromCharCode(10)) && !text.endsWith(String.fromCharCode(10, 10)), 'One final newline: ' + name)
  assert.ok(!text.includes(String.fromCharCode(0)), 'No NUL bytes: ' + name)
  for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    const target = match[1]
    if (/^[a-z]+:/i.test(target)) continue
    await access(resolve(root, target))
  }
}
console.log('Bilingual README pairing, local file links and final newline checks passed (' + record.size + ' sections)')
