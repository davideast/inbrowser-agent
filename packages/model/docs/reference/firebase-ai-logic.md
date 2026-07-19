# Firebase AI Logic

`createFirebaseAiLogicModelClient()` wraps a caller-constructed Firebase AI
Logic `GenerativeModel` as the package's shared `ModelClient`.

## Construct the Model in the Host

The application owns Firebase initialization, Authentication, App Check,
Gemini backend selection, Vertex AI location, and model construction:

```ts
import { initializeApp } from 'firebase/app';
import { getAI, getGenerativeModel, GoogleAIBackend } from 'firebase/ai';
import { createFirebaseAiLogicModelClient } from '@inbrowser/model/providers/firebase-ai-logic';

const app = initializeApp(firebaseConfig);
// Configure App Check for this app before production requests.
const ai = getAI(app, { backend: new GoogleAIBackend() });
const model = getGenerativeModel(ai, { model: 'gemini-3.5-flash' });

const client = createFirebaseAiLogicModelClient(model);
```

To use the Vertex AI Gemini API, construct the `AI` instance with the
appropriate `VertexAIBackend` and location before creating the model. The
adapter does not inspect or change that choice.

`@inbrowser/model` does not depend on `firebase`. The adapter accepts the
narrow structural shape it uses, so the host installs Firebase and controls
its version and lifecycle.

## API

```ts
createFirebaseAiLogicModelClient(model, options?): ModelClient
```

`model` must provide:

```ts
interface FirebaseAiLogicGenerativeModelLike {
  readonly model: string;
  generateContentStream(
    request: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<{
    stream: AsyncIterable<unknown>;
    response: Promise<unknown>;
  }>;
}
```

Options:

| Option | Meaning |
| --- | --- |
| `id` | Metrics/provenance id; defaults to `firebase-ai-logic:${model.model}` |
| `temperature` | Construction-time default; a `ModelRequest.temperature` value wins |

The returned client has `supportsTools: true`.

## Supported Mapping

Each `chat()` call is stateless and sends the full `ModelRequest` through
`generateContentStream()`; it does not create a Firebase `ChatSession`.

- System messages are joined into one Firebase system instruction.
- User, assistant, and adjacent tool-result messages become Firebase `user`,
  `model`, and grouped `function` content.
- Custom `ToolSpec` declarations are converted to Firebase function
  declarations. Common JSON Schema-only annotations are removed; unsupported
  structural or validation keywords fail as a terminal, non-retryable error
  instead of being sent ambiguously.
- Tool execution remains with `@inbrowser/agent` or the caller. Firebase
  `functionReference` and automatic tool execution are not used.
- Upstream function-call ids are preserved. Calls without one receive a stable
  local id; local ids are not replayed to Firebase.
- Gemini thought signatures are captured from function-call parts and replayed
  on the next request.
- Temperature, top-p, top-k, and `ReasoningEffort` are mapped. Gemini 3.x uses
  uppercase thinking levels; Gemini 2.5 uses thinking budgets. `off` leaves the
  model default unchanged.
- Requests use a `65,536` maximum output-token budget so large function
  arguments are not silently truncated.

The event stream contains:

- `text` for visible text;
- `thinking` for returned thought summaries;
- completed `tool_call` events after streamed call snapshots are assembled;
- one terminal `usage` event using the latest prompt, output, cached, and
  thinking-token counts;
- or one terminal `error` event with normalized Firebase status/details,
  including prompt and candidate-level content blocks.

The caller's `AbortSignal` is forwarded to Firebase. Caller cancellation ends
the stream silently, matching the other `ModelClient` implementations.

## Deliberate Exclusions

This adapter covers the common text and caller-run custom-tool path. It does
not expose:

- Gemini Live API sessions;
- Imagen;
- server-side prompt templates;
- Firebase built-in Search, Maps, URL-context, or code-execution tools;
- Firebase automatic function execution;
- multimodal input/output events;
- structured-output or safety-setting request fields;
- token counting or model discovery;
- Firebase hybrid/on-device lifecycle controls.

Those capabilities need contracts other than the current text/tool-oriented
`ModelClient` rather than more switches on this adapter.

## Relay Compatibility

The adapter is not directly a `ModelClientFactory`. The relay factory receives
only `{ apiKey?, model }`, while Firebase AI Logic requires a constructed model
bound to a Firebase app and security context. The relay also currently requires
a BYOK or server-managed key before invoking a provider. Page-direct use works;
first-class relay routing needs a separate provider-authentication policy.

For the design and feature ROI, see the
[Firebase AI Logic provider assessment](../explanation/firebase-ai-logic-provider-assessment.md).
