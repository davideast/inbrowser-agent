<!--
Write for a reviewer, not as a work log.

Completion criterion — post only when every item is true:

1. The opening is one sentence naming the concrete change and what it is.
2. A runnable consumer example follows immediately. It defines every input,
   uses real imports and values, and explains domain terms in plain language.
3. Every changed public entry point is demonstrated through usage. Add more
   code, output, or tables when one example cannot cover the whole surface.
4. Risk appears near the top and states what could break and what needs
   reviewer judgment.
5. Every narrative heading states a fact specific to this change.
6. Code, output, or a table appears before prose that explains it.
7. Verification, findings, and declined alternatives live in <details>.
8. Coverage changes state the numeric delta and its cause, including whether
   scenarios were added, removed, or reclassified.
9. Every sentence passes the reuse test: if it could appear unchanged in a
   different PR, cut it.
10. Replace every placeholder and delete this instruction comment.

State mechanisms precisely with the codebase vocabulary. Keep each meaning in
one place.
-->

REPLACE: One sentence naming what this PR changes and what it is.

```ts
// REPLACE: Runnable consumer code that defines every value it uses and shows
// the result. Change the fence language when TypeScript is not appropriate.
```

## Risk

<!--
REPLACE: State what could break, what needs judgment, and why the risk is
bounded. Delete this section only when there is genuinely no risk.
-->

## REPLACE: A heading that states a fact about this change

<!--
REPLACE: Show code, output, or a table first. Follow it with only the explanation
the example cannot carry. Repeat fact-based sections until every changed public
entry point has been used.
-->

<details>
<summary>Implementation notes and verification</summary>

<!--
REPLACE: Record findings, decisions declined, commands, exit codes, test counts,
and coverage deltas with their causes.
-->

</details>
