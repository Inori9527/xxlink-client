import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

import ts from 'typescript'

// PROVES:         Part executed, part source text. For
//                 src/services/update-content-policy.ts only, the script EXECUTES the
//                 code under test: it reads the real .ts file, transpiles it with the
//                 TypeScript compiler, runs it in a vm sandbox, and calls the exported
//                 getSafeUpdateLink against constructed inputs while reading
//                 UPDATE_MARKDOWN_ALLOWED_ELEMENTS.
// DOES NOT PROVE: Nothing about the runtime behaviour of the viewer or the Rust updater
//                 — neither is imported, compiled or run, only string-matched.

const policyPath = 'src/services/update-content-policy.ts'
const viewerPath = 'src/components/setting/mods/update-viewer.tsx'
const updaterPath = 'src-tauri/src/core/updater.rs'

const policySource = fs.readFileSync(policyPath, 'utf8')
const compiled = ts.transpileModule(policySource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const module = { exports: {} }
vm.runInNewContext(compiled, { module, exports: module.exports, URL })

const { getSafeUpdateLink, UPDATE_MARKDOWN_ALLOWED_ELEMENTS } = module.exports

assert.equal(
  getSafeUpdateLink('https://xxlink.net/download'),
  'https://xxlink.net/download',
)
assert.equal(
  getSafeUpdateLink(
    'https://github.com/Inori9527/xxlink-client/releases/tag/v2.4.16',
  ),
  'https://github.com/Inori9527/xxlink-client/releases/tag/v2.4.16',
)
assert.equal(
  getSafeUpdateLink('https://github.com/attacker/fake-release'),
  null,
)
assert.equal(getSafeUpdateLink('https://example.com/release'), null)
assert.equal(getSafeUpdateLink('https://user:secret@example.com/release'), null)
assert.equal(getSafeUpdateLink('http://example.com/release'), null)
assert.equal(getSafeUpdateLink('https://xxlink.net:8443/download'), null)
assert.equal(getSafeUpdateLink('javascript:alert(1)'), null)
assert.equal(
  getSafeUpdateLink('data:text/html,<script>alert(1)</script>'),
  null,
)
assert.equal(getSafeUpdateLink('//example.com/release'), null)
assert.equal(getSafeUpdateLink(`https://example.com/${'a'.repeat(2048)}`), null)
assert.equal(UPDATE_MARKDOWN_ALLOWED_ELEMENTS.includes('img'), false)
assert.equal(UPDATE_MARKDOWN_ALLOWED_ELEMENTS.includes('iframe'), false)

const viewerSource = fs.readFileSync(viewerPath, 'utf8')
assert.doesNotMatch(viewerSource, /rehypeRaw|rehype-raw/)
assert.match(viewerSource, /allowedElements=/)
assert.match(viewerSource, /skipHtml/)
assert.match(viewerSource, /component="button"/)
assert.doesNotMatch(viewerSource, /href=\{safeHref\}/)
assert.match(viewerSource, /openUrl\(safeHref\)/)

const updaterSource = fs.readFileSync(updaterPath, 'utf8')
assert.match(updaterSource, /textContent = \{version_text\}/)
assert.match(updaterSource, /replace\('<', "\\\\u003c"\)/)
assert.doesNotMatch(updaterSource, /<div class="sub">v\{version\}<\/div>/)

console.log('update content policy validation passed')
