import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname)
const fixture = path.join(projectRoot, 'tests', 'fixture-spd')

function text(filePath) { return fs.readFileSync(filePath, 'utf8') }
function nameFrom(section) {
  return [...section.matchAll(/<Nm\d+>\s*(-?\d+)\s*<\/Nm\d+>/g)].map(m => Number(m[1])).filter(n => n > 0).map(n => String.fromCharCode(n)).join('').trim()
}
function tags(section) {
  const o = {}
  for (const m of section.matchAll(/<([A-Za-z0-9_]+)>\s*(-?\d+(?:\.\d+)?)\s*<\/\1>/g)) o[m[1]] = Number(m[2])
  return o
}

const kitDir = path.join(fixture, 'Roland', 'SPD-SX', 'KIT')
const prmDir = path.join(fixture, 'Roland', 'SPD-SX', 'WAVE', 'PRM')
const kitFiles = fs.readdirSync(kitDir).filter(f => /^kit\d+\.spd$/i.test(f))
let padCount = 0
const kits = []
for (const file of kitFiles) {
  const raw = text(path.join(kitDir, file))
  const head = raw.match(/<KitPrm>([\s\S]*?)<PadPrm>/)?.[1] ?? raw
  const fields = tags(head)
  const pads = [...raw.matchAll(/<PadPrm>([\s\S]*?)<\/PadPrm>/g)].map(m => tags(m[1]))
  padCount += pads.length
  kits.push({ file, name: nameFrom(head), tempo: (fields.Tempo ?? 0) / 10, pads })
}

let wavePrmCount = 0
const waves = []
for (const bank of fs.readdirSync(prmDir)) {
  if (!/^\d+$/.test(bank)) continue
  for (const file of fs.readdirSync(path.join(prmDir, bank))) {
    const m = file.match(/^(\d+)\.spd$/i)
    if (!m) continue
    const id = Number(bank) * 100 + Number(m[1])
    const raw = text(path.join(prmDir, bank, file))
    waves.push({ id, name: nameFrom(raw), path: raw.match(/<Path>(.*?)<\/Path>/)?.[1] ?? '', tag: Number(raw.match(/<Tag>(-?\d+)<\/Tag>/)?.[1] ?? -1) })
    wavePrmCount++
  }
}

assert.equal(kitFiles.length, 26, 'Expected 26 kit files')
assert.equal(wavePrmCount, 443, 'Expected 443 wave PRM files')
assert.equal(padCount, 390, 'Expected 15 pads per 26 kits')
assert.equal(kits.find(k => k.file === 'kit000.spd')?.name, 'FuseBeat')
assert.equal(Math.round(kits.find(k => k.file === 'kit000.spd')?.tempo ?? 0), 120)
assert.equal(kits.find(k => k.file === 'kit099.spd')?.name, 'Agi Kit')
assert.equal(kits[0].pads[0].Wv, 161)
assert.equal(waves.find(w => w.id === 0)?.name, 'Clap_110')

console.log('SPD-SX parser fixture verification PASSED')
console.log(`Kits: ${kitFiles.length}`)
console.log(`Pads: ${padCount}`)
console.log(`Wave PRM: ${wavePrmCount}`)
console.log(`Kit 000: ${kits.find(k => k.file === 'kit000.spd')?.name} / ${kits.find(k => k.file === 'kit000.spd')?.tempo} BPM`)
console.log(`Kit 099: ${kits.find(k => k.file === 'kit099.spd')?.name}`)
