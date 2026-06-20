# honeyhub-sb-explorer

A tiny, optional .NET CLI tool (not a NuGet library) that HoneyHub's bridge shells
out to for Azure Service Bus **data-plane** operations that `az` cannot perform
(message browse/peek, resubmit, purge, send, receive). It authenticates with
`DefaultAzureCredential`, reusing the operator's `az login` (no connection string),
so it needs the **Azure Service Bus Data Receiver** role for read verbs and
**Data Sender** / **Data Owner** for the write verbs (ADR-0094 D5).

Each invocation emits a single JSON document on stdout and exits 0 on success; on
failure it writes a short message to stderr and exits non-zero. The bridge maps the
exit/stderr to a sanitized hint and never surfaces raw stderr to the UI.

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
