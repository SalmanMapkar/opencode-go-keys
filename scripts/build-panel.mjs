// Compiles the Solid panel with the exact transform @opentui/solid itself
// uses (babel-preset-solid, generate universal, moduleName @opentui/solid).
// tsc emits dist/panel/view.js first with the wrong (react-jsx) runtime;
// this overwrites it in place. Fails loudly so a broken panel never ships.
import { transformFileSync } from "@babel/core"
import solid from "babel-preset-solid"
import typescript from "@babel/preset-typescript"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

const files = ["src/panel/view.tsx"]
for (const file of files) {
  const out = file.replace(/^src\//, "dist/").replace(/\.tsx$/, ".js")
  const result = transformFileSync(file, {
    configFile: false,
    babelrc: false,
    presets: [[solid, { moduleName: "@opentui/solid", generate: "universal" }], [typescript]],
  })
  if (!result?.code) {
    console.error(`panel build produced no output for ${file}`)
    process.exit(1)
  }
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, result.code)
  console.log(`panel built: ${out}`)
}
