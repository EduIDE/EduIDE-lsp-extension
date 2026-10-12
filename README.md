# My Java LSP Connector

## Description

This extension serves as a simple connector for Visual Studio Code and Eclipse Theia to an external, network-accessible Java Language Server. Instead of spawning its own language server, it connects to a pre-configured TCP endpoint.

This is part of a research project at the Technical University of Munich.

## Features

-   Connects to a configurable host and port.
-   Provides standard Language Server Protocol (LSP) features for Java, powered by the connected backend server. This includes:
    -   Diagnostics (Errors and Warnings)
    -   Code Completion
    -   Hover Information
    -   Go to Definition

## Configuration

The language server endpoints come from the environment:

-   `SIDECAR_CONFIG`: JSON array of `{ name, host, port, languages, token? }` entries.
-   Legacy fallback: `LS_HOST`/`LS_PORT` and the per-language `LS_JAVA_HOST`/`LS_JAVA_PORT`, `LS_RUST_HOST`/`LS_RUST_PORT` variables.

If a host is missing or empty it defaults to loopback (`127.0.0.1`), which matches the intended same-pod sidecar deployment.

## Security

The connection to the language server is a plain TCP socket with **no TLS and no server authentication**. On a flat or shared network a rogue pod could impersonate the language server and drive `workspace/applyEdit` to plant files in the workspace. The primary control is network isolation (a Helm NetworkPolicy), with the following defenses in depth in this client:

-   **Endpoint pinning**: only loopback hosts are allowed by default. Any other host must be explicitly allowlisted via `LS_ALLOWED_HOSTS` (a comma-separated list of host names, `*` wildcards allowed, e.g. `*.svc.cluster.local`). The client refuses to connect to a host that is neither loopback nor allowlisted, and refuses invalid ports.
-   **Optional handshake token**: set `LS_AUTH_TOKEN` (or a per-entry `token` in `SIDECAR_CONFIG`) and the client sends an `X-LS-Auth: <token>` line before the LSP stream starts, so a cooperating server can reject unauthenticated clients. It is off by default and requires server support.

**Follow-up**: real server authentication requires mTLS (or an equivalent authenticated channel). That is intentionally out of scope for this client and tracked separately.