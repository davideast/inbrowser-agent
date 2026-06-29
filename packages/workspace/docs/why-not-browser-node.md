# Why This Is Not Browser Node

`@inbrowser/workspace` exists because a browser app builder needs a reliable
project runtime, not a partial illusion of a desktop Node environment.

The browser can run a surprising amount of development tooling, but the failure
mode matters. A real dev server wants long-lived processes, sockets, filesystem
watching, package installation, and many small Node APIs. Each one can be
shimmed. The problem is that every shim adds another place where the preview can
fail for reasons unrelated to the user's app.

The workspace package chooses a narrower contract.

## Compile And Mount Beats Serving

The preview runtime compiles the app entry with `esbuild-wasm`, resolves
relative imports from the workspace file system, and evaluates the result
against host-provided modules. There is no HTTP server to keep alive and no
port to proxy.

This is less general than a Vite dev server. It will not run every Vite plugin
or every framework. It is also much easier to explain, test, and recover from:
the app either compiles, evaluates, or throws at render time. Each failure has a
clear diagnostic surface for the UI and the agent.

## Host Modules Are A Boundary

React is supplied by the host application rather than fetched as an arbitrary
package copy. That boundary prevents duplicate React runtime bugs, and it gives
the preview a stable set of known-good modules.

Additional modules can be supplied the same way. If a host wants to provide a
design system, test helpers, or platform APIs, it should register them as host
modules instead of asking the generated app to rediscover them through a fake
Node resolver.

## The Shell Is For Workspace Tasks

The shell is `just-bash` over the workspace file system. It is useful for
simple file-oriented commands and for agent-visible command history. It is not
an operating-system shell. It should not be treated as the place where all
developer tooling must work.

When a capability is important, expose it as a structured service or builtin:
git as `WorkspaceGit`, preview as `ReactPreviewRuntime`, package installation
as `WorkspacePackageRegistry`. Structured services are easier for agents to use
and easier for UI to render than scraped terminal output.

## Git Is A Service, Not A Binary

Git runs as a structured browser workspace service over the same file system.
It writes local refs, browser-native commit metadata, and Git-shaped objects
while exposing status rows, commits, branches, and logs as typed values. A UI
can render changes directly, and an agent can reason over results without
parsing terminal text.

This does not preclude a terminal view. It means terminal text is not the
source of truth for git state.

## The Trade-Off

The package gives up arbitrary server execution in exchange for reliability.
That is the central trade-off.

For a browser-native app builder, this is the better default. The user wants to
see files change, preview the app, inspect errors, and commit work. Those flows
do not require a real Node process. They require a coherent workspace runtime
whose limits are explicit.
