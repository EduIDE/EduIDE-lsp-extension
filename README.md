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

This extension can be configured via the standard VS Code settings. Currently, the host and port are hard-coded in `extension.ts` but can be externalized to the settings in a future version.

## Development

Run `npm ci`, then `npm run lint` and `npm test`. The tests launch VS Code through `vscode-test`; on a headless Linux machine run them as `xvfb-run -a npm test`, which is what CI does on every pull request and push to `main`.
