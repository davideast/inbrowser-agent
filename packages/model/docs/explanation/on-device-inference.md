# On-Device Inference

Running an LLM in a browser tab is a different exercise from calling a hosted
API. The model is a file you download to the user's machine, and a runtime you
execute on their hardware. This page explains the stack that makes that
possible, the constraints it imposes, and why you would choose it over the
cloud anyway.

For the concrete `dtype`, backend, and per-model figures referenced here, see
[the presets reference](../reference/presets.md).

## The Stack

On-device inference is several layers, each doing one job.

**ONNX** is a file format. A model exported to ONNX is a portable description
of a neural network's graph and weights, the same network frozen into a form
that doesn't depend on the framework it was trained in.

**ONNX Runtime Web** (`onnxruntime-web`) is the execution engine that runs that
graph in a browser. It is the piece that actually does the matrix
multiplications, step by step, to turn a prompt into the next token.

**WebGPU and WASM are its backends.** WebGPU runs the graph on the GPU through
the browser's compute API; it is the fast path, and for a model the size of
Gemma 4 it is effectively required. WASM runs the graph on the CPU through
SIMD instructions; it is always available and much slower, the fallback for
machines or environments without WebGPU. A preset can name a backend
explicitly, or set it to `auto`, which probes for GPU support and picks WebGPU
when present and WASM when not.

**`@huggingface/transformers`** sits on top and orchestrates the rest. It
loads the tokenizer, applies the model's chat template to turn messages into
input ids, drives ONNX Runtime Web through the decode loop, and decodes output
ids back into text. The engine in this package wraps that orchestration behind
its own narrow surface.

The layering is worth holding onto because each layer answers a different
question. ONNX is *what the model is*. ONNX Runtime Web is *what runs it*.
WebGPU and WASM are *where it runs*. transformers.js is *what glues the pieces
into a chat loop*.

## Precision Is Not Parameter Count

A model has a parameter count, how many weights it has, and that is the
number people quote. But how those weights are stored is a separate axis, and
it is the one you actually choose when you pick a preset. That axis is `dtype`:
the precision of the weights and activations.

`q4f16` stores weights as 4-bit integers with 16-bit-float activations. `q8`
uses 8-bit integer weights. `fp16` and `fp32` keep half and full floating-point
precision throughout. The same model, the same parameter count, can be exported
at any of these.

The choice is a trade. Lower precision means a smaller file to download and
less memory to hold, which is the difference between a model that fits in a
browser tab and one that doesn't. But quantising weights to 4 bits discards
information, and at some point that shows up as degraded output quality. There
is no universally correct answer; it depends on the model, the task, and the
hardware budget. The presets in this package lean on `q4f16` because, for the
models they ship, it is the point where the size cost and the quality cost
balance out for in-browser use. A heavier `dtype` buys quality you may not need
at a download size the browser may not tolerate.

The thing to internalise is that "how big is this model" has two answers. The
parameter count tells you the model's capacity. The `dtype` tells you what it
actually costs to run.

## Cold Start Versus Warm Decode

The first time you generate with a fresh engine is slow in a way later
generations are not, and the reason is worth understanding because it shapes
how the surface is built.

A cold start is three observable phases. **Fetch** pulls the weights, from the
HuggingFace Hub by default, into the browser's cache. For a multi-hundred-
megabyte model over a normal connection, this dominates the first run.
**Init** is ONNX Runtime compiling the graph for the chosen backend. **Warmup**
is a first forward pass that primes the GPU pipelines and kernel caches so the
real decode loop runs at full speed. Only after those does the engine reach a
ready state where generation is safe.

A warm decode is what happens on every subsequent call against a ready engine:
no fetch, no compile, no warmup, just the decode loop turning tokens. This is
why the first `generate` feels heavy and the rest feel instant.

The fetch cost, crucially, is mostly paid once across page loads, not once per
generation. The browser caches the downloaded weights, so a second visit
re-uses them rather than re-downloading. Graph compilation, by contrast, is
per page load today; the warmup primes a fresh engine instance each time. The
practical upshot is a surface that exposes a `ready` step distinct from
generation: you arrange to pay the cold-start cost when it is least disruptive,
behind a loading affordance, ahead of the user's first prompt, so that when
they do ask something, they get a warm decode.

## Why On-Device At All

The stack above is more work than a single HTTPS call to a hosted model. It is
worth being clear about what that work buys, and what it costs, because the
trade-off is the whole reason the package exists.

The case for on-device is strong where it applies. **Privacy** is the headline:
the prompt and the data never leave the device, because there is no server to
send them to. For anything sensitive, a user's notes, their files, their
messages, that is not a feature you can replicate by promising not to log; the
data physically does not travel. **Offline** follows for free: once the weights
are cached, generation works with no network at all. And **cost** collapses:
there is no per-token bill, because the user's own hardware is doing the
inference. A feature that would be too expensive to offer at scale against a
metered API can be free when every user brings their own compute.

The costs are equally real and should not be soft-pedalled. The model is a
**download**, and a meaningful one, hundreds of megabytes to gigabytes,
depending on the preset. It runs on **whatever hardware the user has**, which
means WebGPU support and GPU memory become hard constraints; a model that
loads on a desktop GPU may simply not fit a phone. And the models that
realistically run in a tab are **smaller** than the frontier models a cloud API
serves, so for the hardest reasoning tasks the on-device answer will be weaker.

So the honest position: on-device inference is the right default when privacy,
offline capability, or per-token cost dominate, and the task fits a small
model. When you need the largest possible model and the data is not sensitive,
a hosted API is still the better tool. The point of this package is to make the
on-device side a real, usable option, not to claim it wins everywhere.
