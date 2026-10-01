# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Bazlama is an on-prem, low-code web application platform on .NET 10, built as a **prototype** for now. It is "OS-like", with three areas on one host: **Runtime** (runs published apps), **Development** (designers, a Monaco C# editor, publish/export) and **Management** (users, groups, organization, app import).

`docs/architecture.md` is the source of truth for decisions, phases (Fazlar) and open questions. Read it before designing anything. `docs/qmex-analysis.md` is reference material only: replacing QMEX is a long-term idea, not a prototype goal. The user writes in Turkish, and the docs are in Turkish.

## Commands

```bash
# .NET (solution: Bazlama.slnx; SDK pinned by global.json)
dotnet build Bazlama.slnx
dotnet test Bazlama.slnx                            # all tests (SqlServer/PostgreSql skip without Docker)
dotnet test Bazlama.slnx --filter "FullyQualifiedName~SqliteKernelDatabaseTests"          # one class
dotnet test Bazlama.slnx --filter "FullyQualifiedName~Reports_installation_and_provider"  # one test
dotnet run --project src/Bazlama.Host               # http://localhost:5400

# EF migrations: one set per provider. After changing KernelDbContext, add the same migration to all three:
dotnet tool restore
dotnet ef migrations add <Name> --project src/Bazlama.Data.Sqlite     -o Migrations
dotnet ef migrations add <Name> --project src/Bazlama.Data.SqlServer  -o Migrations
dotnet ef migrations add <Name> --project src/Bazlama.Data.PostgreSql -o Migrations

# Web UI (web/)
cd web && npm install
npm run dev          # http://localhost:5401, proxies /api to the host on 5400
npm run typecheck
npm test             # vitest (jsdom)
npm run build        # outputs to src/Bazlama.Host/wwwroot (gitignored), served by the host
```

## Architecture

- **Provider-neutral kernel data.** `KernelDbContext` (`src/Bazlama.Kernel.Data`) holds only the platform's system tables.
  - Each database has its own assembly, `src/Bazlama.Data.{SqlServer,PostgreSql,Sqlite}`. It contains an `IDatabaseProvider`, that provider's EF migrations, a design-time factory, and later the provider's SQL dialect.
  - The host picks the provider from `Database:Provider` and `Database:ConnectionString` (`src/Bazlama.Host/DatabaseSetup.cs`), and migrates at startup when `Database:MigrateOnStartup` is set.
- **All three databases are first-class.**
  - `tests/Bazlama.Tests/Data/KernelDatabaseTests.cs` runs the same tests on every provider. SqlServer and PostgreSql use Testcontainers and are skipped when Docker is not running; SQLite runs in memory.
  - Avoid provider-specific SQL outside the provider assemblies.
- **Sign-in and sessions** live in `src/Bazlama.Modules.Identity`.
  - The cookie carries only a session id. State lives in `sys_user_sessions`, and a session moves through these statuses: password accepted → `PendingMfa` / `PendingMfaEnrollment` → `PendingPasswordChange` → `Active`. MFA comes before the password change on purpose.
  - `SessionMiddleware` loads the session (a 30 s cache) into the scoped `CurrentSession`. It ends idle sessions and treats ended sessions as anonymous.
  - Protect endpoints with `.RequireActiveSession()` or `.RequirePermission(Permissions.X)`. Permissions come from groups; `*` grants everything. After changing groups, memberships or permissions, call `SessionStore.PermissionsChanged()`.
  - Every non-GET `/api` call must send the `X-Bazlama-Request` header (CSRF guard). The web client's `api.ts` does this.
  - Errors return as `{ errors: [...] }` with Turkish, user-facing messages.
  - Use the injected `TimeProvider`, never `DateTime.Now`. The tests control time with `TestClock` (`tests/Bazlama.Tests/TestHost.cs`).
- **Audit.** `AuditInterceptor` writes an `AuditEvent` for every change to an `IAudited` entity in the same `SaveChanges`. It masks secrets. Security events (logins, lockouts, MFA) are written explicitly by `AuthService`.
- **App data (planned, Faz 2).** App tables will be generated from metadata as real tables (`app_<appKey>_<entity>`), not mapped through EF.
  - The data engine enforces company / location / plant / period scoping, so app code cannot forget it.
  - Ids are Guid v7 and times are UTC.
- **App code (planned, Faz 3).** App code is server-side C#. Roslyn compiles it to one DLL per app version, and each version loads into its own collectible `AssemblyLoadContext`.
- **Web UI (`web/`).** Built on the user's own zero-dependency web component library (`bz-*` elements, signals, the `html` template, and `@bazlama/router` with `definePage` and hash routing).
  - The `@bazlama/*` packages are consumed **from source in the sibling repo** `../Bazlama.Web.Component/next/packages`, through aliases in `web/vite.config.ts` and `web/tsconfig.json`. Both repos must sit in the same parent folder.
  - The component library's README (`../Bazlama.Web.Component/next/README.md`) documents the component APIs and design rules.
  - Monaco is to be loaded lazily, and only in the Development area.

## Conventions

- `Directory.Build.props` sets net10.0, nullable and **TreatWarningsAsErrors**.
- Package versions live only in `Directory.Packages.props` (central package management).
- Tests use xUnit v3 (`TestContext.Current.CancellationToken`, `Assert.SkipWhen`). Testcontainers throws in `Build()` when Docker is missing, so containers are built inside `StartContainerAsync`, never in field initializers.
- Dev ports: host 5400, Vite 5401 (the component library playground uses 5391).
