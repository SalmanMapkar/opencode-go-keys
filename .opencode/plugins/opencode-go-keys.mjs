// Entry point OpenCode's location loader discovers inside installed npm
// packages (same layout as @dietrichgebert/ponytail). Re-exports the built
// server plugin; the TUI view loads through the package "./tui" export.
export { default } from "../../dist/index.js"
