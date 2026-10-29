// Phase-A gate: native SDK calls stay out of pure policy; no new dependency cycles.
// Runs after locked dependencies and SDK preparation in the existing typecheck job.
// Tier C fixed protocol. Missing tool/cache is BLOCKED, never a skipped check.
import { spawnSync } from 'node:child_process'
import { relative, resolve } from 'node:path'
import * as ts from 'typescript'

const root = resolve(import.meta.dir, '../..')
const project = resolve(root, 'architecture')
// arch-viewer can omit an SDK import resolved to an engine-written declaration.
// Check the actual static specifier, including import type, before resolution.
const config = ts.readConfigFile(resolve(project, 'tsconfig.json'), ts.sys.readFile)
const compiler = ts.parseJsonConfigFileContent(config.config, ts.sys, project)
const diagnostics = [...(config.error ? [config.error] : []), ...compiler.errors]
if (diagnostics.length > 0) {
  console.error('BLOCKED: Track architecture compiler input is unavailable: ' +
    diagnostics.map(row => ts.flattenDiagnosticMessageText(row.messageText, '\n')).join('\n'))
  process.exit(2)
}
const sdkImports: string[] = []
for (const file of compiler.fileNames.filter(name => !name.endsWith('.d.ts'))) {
  if (relative(root, file) === 'hooks/register.tsx') continue
  const source = ts.createSourceFile(file, ts.sys.readFile(file)!, ts.ScriptTarget.Latest, true)
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
    const specifier = statement.moduleSpecifier
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue
    const name = specifier.text
    if (name !== 'claude-code' && !name.startsWith('claude-code/') && name !== 'claude-code-tools' && name !== 'claude-code-mcp') continue
    // Step-view release gate: native constructors cross as types, never capabilities.
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined
    const bindings = clause?.namedBindings
    if (relative(root, file) === 'hooks/pane-elements.ts' && name === 'claude-code' &&
      clause?.isTypeOnly === true && clause.name === undefined && bindings !== undefined &&
      ts.isNamedImports(bindings) && bindings.elements.length === 1 &&
      bindings.elements[0]!.name.text === 'ElementTable' && bindings.elements[0]!.propertyName === undefined) continue
    const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1
    sdkImports.push(`${relative(root, file)}:${line}: SDK import ${name} must stay in the native adapter`)
  }
}
if (sdkImports.length > 0) {
  console.error(sdkImports.join('\n'))
  process.exit(1)
}
const uv = Bun.which('uv')
if (uv === null) {
  console.error('BLOCKED: Track architecture check requires uv; see track/architecture/README.md.')
  process.exit(2)
}
const run = spawnSync(uv, [
  'run', '--project', project, '--frozen', 'archview', 'check', root,
  '--config', resolve(project, 'archview.toml'), '--format', 'json',
], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })
if (run.stdout) process.stdout.write(run.stdout)
if (run.stderr) process.stderr.write(run.stderr)
if (run.signal === 'SIGINT') process.exit(130)
let report: { project?: unknown; ok?: unknown; problems?: unknown } | undefined
try { report = JSON.parse(run.stdout ?? '') } catch { /* Tool setup errors are not architecture reports. */ }
const validReport = report !== null && typeof report === 'object' &&
  typeof report.project === 'string' && typeof report.ok === 'boolean' && Array.isArray(report.problems)
const pass = validReport && run.status === 0 && report!.ok === true
const violation = validReport && run.status === 1 && report!.ok === false && (report!.problems as unknown[]).length > 0
if (run.error !== undefined || !pass && !violation) {
  console.error('BLOCKED: Track architecture tool or locked environment is unavailable; see track/architecture/README.md to warm the cache. No check was skipped.')
  process.exit(2)
}
process.exit(run.status)
