# @inbrowser/sandbox

This package owns runtime-agnostic sandbox orchestration for the inbrowser stack.

- Keep browser workspace primitives in `@inbrowser/workspace`.
- Keep model/provider logic in `@inbrowser/model`.
- Keep agent loop logic in `@inbrowser/agent`.
- Do not import React, DOM UI, or product-specific site code here.
- Prefer typed service results over terminal text parsing.
