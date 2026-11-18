#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { expandSuite } from '../pipeline/orchestrator.mjs'
import { ROOT } from '../pipeline/lib/env.mjs'

const { values } = parseArgs({options:{suite:{type:'string',default:'full'}}})
const steps = expandSuite(values.suite)
const projects = [...new Set(steps.filter(s=>s.adapter==='playwright').map(s=>s.project))]
const commands = steps.some(s=>s.grep || s.grepInvert)
  ? steps.filter(s=>s.adapter==='playwright').map(s=>[`--project=${s.project}`,...(s.grep?['--grep',s.grep]:[]),...(s.grepInvert?['--grep-invert',s.grepInvert]:[])])
  : [projects.map(p=>`--project=${p}`)]
const reports = commands.map(args=>JSON.parse(execFileSync(process.execPath, ['node_modules/@playwright/test/cli.js','test','--list','--reporter=json',...args], {cwd:ROOT,encoding:'utf8',maxBuffer:20*1024*1024})))
const seen = new Set()
const counts = new Map(), manual = new Map()
function visit(suite) {
  for (const spec of suite.specs ?? []) for (const test of spec.tests) {
    const key = `${test.projectName}:${spec.id}`
    if (seen.has(key)) continue
    seen.add(key)
    counts.set(test.projectName,(counts.get(test.projectName) ?? 0)+1)
    if (spec.tags?.some(tag=>tag.replace(/^@/,'')==='manual')) manual.set(test.projectName,(manual.get(test.projectName) ?? 0)+1)
  }
  for (const child of suite.suites ?? []) visit(child)
}
reports.forEach(report=>report.suites.forEach(visit))
console.log(`Suite ${values.suite}: ${[...counts.values()].reduce((a,b)=>a+b,0)} discovered Playwright cases`)
for(const project of projects) console.log(`  ${project}: ${counts.get(project) ?? 0} cases (${manual.get(project) ?? 0} marked manual)`)
for(const step of steps.filter(s=>s.adapter!=='playwright')) console.log(`  ${step.adapter}: separate runtime workload; not counted as Playwright cases`)
console.log('Discovery does not execute tests. Isolated writes, seeded inputs, external accounts and the extension build must be available before their cases can execute.')
