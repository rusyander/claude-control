# Finding card — the published shape (gitlab-publish.md §5)

Labels go in the team's language (the user's, unless told otherwise); the shape stays.

````markdown
[🔴 blocking | 🟡 before merge | ❓ question | 🟢 nit] F-NN **<Thesis in one line: what is broken and what it costs.>**

**Where:** `<path>:<start>-<end>` (other sites: `<path2>:<line>`)

```<lang>
// <path>:<start>-<end> — lines verbatim from the MR head
```

**What breaks and why.** <Code path, input, result.>

**How it was found.** 1) … 2) … 3) …

**How to reproduce.**

```
<command / request with concrete input>
```

Expected: … · Actual: …

| run                    | result |
| ---------------------- | ------ |
| branch as is           | …      |
| mutant / after the fix | …      |

**How to fix.** <Code change + a test that goes red without it.>
````
