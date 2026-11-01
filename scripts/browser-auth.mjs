/** Normal browser-cookie issuance through the existing auth service; no secret or cookie is logged or persisted. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
export async function browserCookie(checkout, home, origin) {
  const { default: Credentials } = await import(pathToFileURL(resolve(checkout, 'packages/credentials/credentials-local/src/index.ts')).href)
  const { BrowserAuth } = await import(pathToFileURL(resolve(checkout, 'packages/client/connection/src/browser-auth.ts')).href)
  const ctx = new Context()
  const fiber = ctx.plugin(Credentials, { dshHome: home, watch: false })
  try {
    await fiber
    const credentials = ctx.get('credentials')
    assert.ok(credentials)
    const readOnly = { async modifyRecord(key, update) {
      const current = await credentials.readRecord(key)
      assert.ok(current, 'Existing browser authentication is required; refusing to initialize credentials')
      const next = await update(current)
      assert.equal(next, undefined, 'Browser verification must not alter credentials')
      return current
    } }
    const auth = await BrowserAuth.create({}, readOnly, 1)
    const base = new URL(origin)
    const local = new URL(auth.authenticatedUrl(base.href))
    let value
    auth.authorizeIndex({ method: 'GET', url: local.pathname + local.search, headers: { host: base.host } }, {
      writeHead(status, headers) { assert.equal(status, 303); value = headers['set-cookie'] }, end() {},
    })
    assert.equal(typeof value, 'string')
    const pair = value.split(';', 1)[0]
    const at = pair.indexOf('=')
    return { name: pair.slice(0, at), value: pair.slice(at + 1), url: base.origin, httpOnly: true, sameSite: 'Strict', secure: base.protocol === 'https:' }
  } finally { await fiber.dispose() }
}
