## 🛠️ Build/Run Commands
- **Build**: `go build` (ensure `go.mod` is initialized)
- **Lint**: `golangci-lint run` (install via `go install github.com/golangci/golangci-lint@latest`
- **Test**: `go test` (single test: `go test -run=TestName`)
- **Format**: `gofmt -s -w .` (auto-fix with `gofumpt` if available)

## 📜 Code Style Guidelines
- **Imports**: Organize alphabetically, remove unused (`go mod tidy`)
- **Naming**: PascalCase for types, snake_case for vars/funcs; avoid single-letter names
- **Errors**: Use `errors.New()`/`fmt.Errorf()`, prefer checked errors over `panic`
- **Formatting**: 4-space indents, no trailing spaces, align inline `if`/`for` conditions
- **Types**: Prefer explicit types over `interface{}`; use `const` for flags, `iota` for bitmasks

## 🧠 Tooling Rules
- **Cursor Rules**: See `.cursor/rules/` for formatting/structural constraints
- **Copilot Instructions**: Follow `.github/copilot-instructions.md` for context-aware suggestions

## ⚠️ Notes
- Always run `go mod tidy` before commits
- Tests must have `t.Helper()` for subtests
- Use `go generate` for codegen (e.g., `go generate ./...`)

