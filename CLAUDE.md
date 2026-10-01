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
- **Management API.** `src/Bazlama.Modules.Management` serves `/api/management/*`: users, groups, organization, sessions, security settings and audit.
  - Each area sits behind its own `system.*` permission.
  - The guards stop admins from locking themselves out: no self-deactivation, no leaving Administrators, and the `*` permission stays on the system group.
  - The web pages are in `web/src/management/`. They share helpers in `ui.ts` (`formDialog`, `loader`, bound fields).
- **Audit.** `AuditInterceptor` writes an `AuditEvent` for every change to an `IAudited` entity in the same `SaveChanges`. It masks secrets. Security events (logins, lockouts, MFA) are written explicitly by `AuthService`.
- **App data engine** (`src/Bazlama.Engine`).
  - **Metadata.** An app is JSON metadata (`Metadata/AppDefinition.cs`; example: `samples/apps/siparis.json`), checked by `MetadataValidator`.
  - **Schema.** `SchemaBuilder` turns each entity into a real table, `app_<app>_<entity>`. It adds the system columns (id, the scope columns, parent_id, audit columns, is_deleted, row_version), foreign keys and indexes.
    - App fields are always NULL in the database; "required" is enforced by the engine.
    - Detail entities inherit their master's scope and period binding.
  - **Upgrades.** `SchemaDiff` plans an upgrade. Dropping columns or tables is destructive and needs a confirmation. Type, scope and parent changes are refused.
  - **Installing.** `AppInstaller` runs the plan in one transaction and stores the definition in `sys_apps` and `sys_app_versions`.
  - **SQL dialects.** `Sql/SqlDialect.cs` is the base; each provider assembly implements it (`SqlServerDialect`, `PostgreSqlDialect`, `SqliteDialect`).
    - SQLite stores Guids and dates like EF Core does (upper-case and ISO text), so app tables can reference kernel tables.
    - SQLite rebuilds a table when a column is dropped.
  - **Data service.** `DataService` does all record access. Every query gets the scope filter from `IRequestContext` (company, location, plant, period). Writes are blocked in closed periods, deletes are soft, `row_version` catches concurrent updates, and every change goes to the audit log.
  - **Permissions.** Each master entity gets `app.<app>.<entity>.read` and `.write`; its details use the master's permissions. `PermissionCatalog` adds them to the kernel permissions.
  - **APIs.** `/api/management/apps` installs apps (Management module). `/api/runtime/data/{app}/{entity}` serves records (`src/Bazlama.Modules.Runtime`).
  - Ids are Guid v7 and times are UTC.
- **App code** (`src/Bazlama.Sdk`, `src/Bazlama.Compiler`, `src/Bazlama.Modules.Development`).
  - App code sees only `Bazlama.Sdk`: `EntityEvents<T>` (Validate, BeforeSave, AfterSave, BeforeDelete), `RecordAction<T>` + `[Action]`, and `IAppContext` (user, context, read-only `Records`).
  - `EntityCodeGenerator` emits typed entity classes (`_Entities.g.cs`, namespace `<App>App`). They are compiled together with the workspace files (`sys_app_code_files`).
  - `AppCompiler` compiles deterministically against a fixed reference set, and a semantic check rejects forbidden APIs (BZ0001: IO, net, reflection, processes, threads…). This is a guard rail, not a sandbox.
  - `AppCodeHost` loads each app's active build (`sys_app_builds`) into its own collectible `AssemblyLoadContext`. A new build swaps in without a restart. Code libraries (`sys_code_library_versions`) load into the same context.
  - `CompiledAppCode` implements the engine's `IAppCode`: records are mapped to the generated classes, there is a time limit, and failures become a refusal. `AfterSave` runs inside the save transaction.
  - Installing a new app version rebuilds its code (`IAppInstallListener`). If that fails, the code is unloaded ("stale").
  - The Development API writes only when `PlatformInfo.CanDevelop`, that is EnvironmentMode=Development.
  - Completion uses Roslyn `CompletionService` (`CodeCompletion`).
- **Development UI** (`web/src/development/`). `workspace.ts` is the Monaco workspace: file list, markers from `/check`, completion from `/complete`.
  - Monaco is imported only in `monaco.ts`: the editor core, `features/register.all` and the C# grammar. It is loaded with a dynamic import.
- **Web runtime** (`web/src/runtime/`). Lists, forms and detail grids are drawn from the metadata. Field editors and grid formatting are in `fields.ts`.
  - The core template treats every function value as a reactive binding. To pass a function to a property (for example `.pick`), wrap it: `.pick=${() => () => pick()}`.
  - `loading()` builds page bodies untracked. Keep it that way, or typing into a form rebuilds the page.
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
- A running `dotnet run` host locks `src/Bazlama.Host/bin`, so builds and tests fail. For manual testing, run a published copy (`dotnet publish src/Bazlama.Host -c Release -o <dir>`) instead.
- Cookies are per host, not per port: two local instances on `localhost` sign each other out. Use `127.0.0.1` for the second one, or set `Platform:CookieName`.
