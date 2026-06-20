# honeyhub-sb-explorer

A tiny, optional .NET CLI tool (not a NuGet library) that HoneyHub's bridge shells
out to for Azure Service Bus **data-plane** operations that `az` cannot perform
(message browse/peek, resubmit, purge, send, receive). It authenticates with
`DefaultAzureCredential`, reusing the operator's `az login` (no connection string),
so each verb needs an Azure Service Bus data-plane role (ADR-0094 D5):

| Verb | Roles required |
| --- | --- |
| `peek` | Data Receiver |
| `purge` | Data Receiver |
| `receive` | Data Receiver |
| `send` | Data Sender |
| `resubmit` | Data Receiver **and** Data Sender |

On success a verb emits a single JSON document on stdout and exits 0. On failure the
exit code is non-zero, but the output is not uniform: a runtime failure writes a short
message to stderr (exit 1), `resubmit` may write a partial-progress JSON document to
stdout while still exiting 1, and argument/usage errors (missing verb, unknown verb,
missing required option) write to stderr with no JSON (exit 2 for the verb-level cases).
The bridge keys off the exit code, maps stderr to a sanitized hint, and never surfaces
raw stderr to the UI.

## Build and install

```sh
dotnet build -c Release tools/honeyhub-sb-explorer/honeyhub-sb-explorer.csproj
```

The HoneyHub bridge locates the helper via the `HONEYHUB_SB_EXPLORER` environment
variable (full path to the built executable) or `honeyhub-sb-explorer` on `PATH`.
When it isn't installed, the cockpit shows an honest "helper not installed" state.

## Verbs

Read-only: `peek`. Write/destructive (gated behind explicit user confirmation in the
bridge): `resubmit`, `purge`, `send`, `receive`.

```sh
honeyhub-sb-explorer peek --namespace <ns.servicebus.windows.net> --entity <queueOrTopic> \
  [--subscription <name>] [--dlq] [--count N]
```
